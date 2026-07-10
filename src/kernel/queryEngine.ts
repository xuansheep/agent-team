import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { buildGlobalPromptAttachment, buildPlanModeAttachment, buildPlanModeReentryAttachment, buildToolPromptsAttachment, hasRuntimeAttachment, type RuntimeAttachment } from "../context/attachments.js";
import { withRuntimeAttachments } from "../context/messages.js";
import { isDefaultPlanFilePath, planFilenameSlug, readPlan, uniquePlanFilePath } from "../plans/planFiles.js";
import { hasModelUsage } from "../model/usage.js";
import type { ModelMessage, ModelProvider, ModelStreamEvent, ModelToolCall } from "../providers/types.js";
import type { GlobalPromptMetadata } from "../config/schema.js";
import type { AuditSink } from "../audit/auditEvent.js";
import type { PromptInjectionRecord, RuntimeEvent } from "../runtime/types.js";
import { skillRuntimeOverridesFromToolResult, skillSystemMessageFromToolResult } from "../skills/skillTools.js";
import { PermissionKernel } from "./permissions/permissionKernel.js";
import { PlanModeController } from "./plan/planModeController.js";
import { closeDanglingExitPlanModeToolCalls, planApprovalToolResultContent } from "./plan/planToolCallMessages.js";
import type { KernelSession } from "./session.js";
import { reduceKernelSession } from "./session.js";
import type { KernelToolRegistry } from "./tools/registry.js";

const maxToolIterations = 20;

export type QueryEngineInput = {
  session: KernelSession;
  provider: ModelProvider;
  model: string;
  effort?: string | number;
  tools: KernelToolRegistry;
  globalPrompt?: string;
  globalPromptMetadata?: GlobalPromptMetadata;
  eventSink?: (event: RuntimeEvent) => void | Promise<void>;
  auditSink?: AuditSink;
  signal?: AbortSignal;
  onStreamEvent?: (event: ModelStreamEvent) => void;
  nodeId?: string;
};

export type QueryEngineResult = {
  session: KernelSession;
};

export class QueryEngine {
  private readonly permissions = new PermissionKernel();
  private readonly planMode = new PlanModeController();

  async run(input: QueryEngineInput): Promise<QueryEngineResult> {
    let session = reduceKernelSession(input.session, {
      type: "status_set",
      status: input.session.toolPermissionContext.mode === "plan" ? "planning" : "running_query"
    });
    const messages = await buildQueryMessages(session, input.tools, input);
    const promptInjection = promptInjectionRecord(input, messages);
    if (promptInjection) await emit(input, { type: "runtime_prompt_injection", session_id: session.id, run_id: session.workflowBinding?.runId, record: promptInjection });
    await emit(input, { type: "runtime_turn_started", session_id: session.id, run_id: session.workflowBinding?.runId });
    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      throwIfAborted(input.signal);
      const request = {
        model: input.model,
        effort: input.effort,
        messages,
        tools: input.tools.visibleTools(session.toolPermissionContext).map((tool) => tool.legacyTool),
        context: {
          runId: session.workflowBinding?.runId ?? session.id,
          nodeId: input.nodeId ?? "kernel",
          attempt: iteration + 1,
          sessionId: session.id,
          threadId: session.id,
          turnId: `${session.id}:${input.nodeId ?? "kernel"}:${iteration + 1}`,
          promptCacheKey: session.id
        },
        signal: input.signal
      };
      const response = input.provider.stream
        ? await input.provider.stream(request, (event) => input.onStreamEvent?.(event))
        : await input.provider.generate(request);
      if (hasModelUsage(response.usage)) await emit(input, { type: "runtime_model_usage", session_id: session.id, run_id: session.workflowBinding?.runId, model: input.model, usage: response.usage, stop_reason: response.stopReason });

      if (!response.tool_calls?.length) {
        if (response.content !== undefined) {
          messages.push({ role: "assistant", content: response.content });
          await emit(input, { type: "runtime_assistant_message", session_id: session.id, run_id: session.workflowBinding?.runId, content: response.content });
        }
        return { session: { ...session, messages, status: "idle_input" } };
      }
      let calls = await callsUntilUserInteraction(response.tool_calls, input.tools, session);
      const preparedPlanWrite = await prepareInitialPlanWrite(session, calls, response.content, messages);
      session = preparedPlanWrite.session;
      calls = preparedPlanWrite.calls;
      messages.push({ role: "assistant", content: response.content ?? "", tool_calls: calls });
      await emit(input, { type: "runtime_assistant_message", session_id: session.id, run_id: session.workflowBinding?.runId, content: response.content ?? "" });

      let pendingPlanApprovalCall: ModelToolCall | undefined;
      let planModePermissionBlocked = false;
      for (const call of calls) {
        input.tools.legacyRegistry?.activateSkillsForInput(call.input, session.cwd);
        const tool = input.tools.get(call.name);
        const permission = await this.permissions.check(tool, call.input, { ...session.toolPermissionContext, cwd: session.cwd });
        if (permission.decision === "ask") {
          if (call.name === "ExitPlanMode" && session.toolPermissionContext.mode === "plan") {
            pendingPlanApprovalCall = call;
            continue;
          }
          return {
            session: reduceKernelSession({ ...session, messages }, {
              type: "pending_interaction_set",
              interaction: {
                type: "tool_permission",
                id: call.id,
                sessionId: session.id,
                tool: call.name,
                input: call.input,
                reason: permission.reason,
                rule: permission.rule
              }
            })
          };
        }
        if (permission.decision === "deny") {
          const error = permissionDeniedMessage(call.name, permission.reason ?? "Permission denied");
          await emit(input, { type: "runtime_tool_failed", session_id: session.id, run_id: session.workflowBinding?.runId, tool_call_id: call.id, tool: call.name, error });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error, permission_denied: true }) });
          if (session.toolPermissionContext.mode === "plan") {
            planModePermissionBlocked = true;
            continue;
          }
          return { session: { ...session, messages, status: "idle_input" } };
        }
      }
      if (planModePermissionBlocked) continue;

      const executableCalls = pendingPlanApprovalCall
        ? calls.slice(0, calls.indexOf(pendingPlanApprovalCall))
        : calls;
      for (const call of executableCalls) {
        const tool = input.tools.get(call.name);
          const context = { cwd: session.cwd, sessionId: session.id, runId: session.workflowBinding?.runId, planState: session.planState ?? undefined, auditSink: input.auditSink, provider: input.provider, model: input.model, toolRegistry: input.tools.legacyRegistry, permissionMode: session.toolPermissionContext.mode };
        const interaction = await tool.requiresUserInteraction(call.input, context);
        if (interaction?.type === "ask_user_question") {
          const result = await tool.execute(call.input, context);
          return {
            session: reduceKernelSession({ ...session, messages }, {
              type: "pending_interaction_set",
              interaction: {
                type: "ask_user_question",
                id: call.id,
                sessionId: session.id,
                toolCallId: call.id,
                questions: interaction.questions ?? questionsFromResult(result)
              }
            })
          };
        }
        if (interaction?.type === "plan_approval") {
          const request = exitPlanRequest(call.input);
          try {
            return { session: await this.planMode.requestPlanApproval({ ...session, messages }, { ...request, toolCallId: call.id }) };
          } catch (error) {
            messages.push({ role: "tool", tool_call_id: call.id, content: planApprovalBlockedMessage(error, session.toolPermissionContext.planFilePath) });
            continue;
          }
        }
        await emit(input, { type: "runtime_tool_invoked", session_id: session.id, run_id: session.workflowBinding?.runId, tool_call_id: call.id, tool: call.name, input: call.input });
          try {
            const result = await tool.execute(call.input, context);
            await emit(input, { type: "runtime_tool_completed", session_id: session.id, run_id: session.workflowBinding?.runId, tool_call_id: call.id, tool: call.name, result });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(tool.mapToolResultToModelResult(result, context)) });
            const skillMessage = skillSystemMessageFromToolResult(result);
            if (skillMessage) messages.push(skillMessage);
            const skillOverrides = skillRuntimeOverridesFromToolResult(result);
            if (skillOverrides?.model) input.model = skillOverrides.model;
            if (skillOverrides?.effort !== undefined) input.effort = skillOverrides.effort;
          } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emit(input, { type: "runtime_tool_failed", session_id: session.id, run_id: session.workflowBinding?.runId, tool_call_id: call.id, tool: call.name, error: message });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) });
        }
      }
      if (pendingPlanApprovalCall) {
        const request = exitPlanRequest(pendingPlanApprovalCall.input);
        try {
          return { session: await this.planMode.requestPlanApproval({ ...session, messages }, { ...request, toolCallId: pendingPlanApprovalCall.id }) };
        } catch (error) {
          messages.push({ role: "tool", tool_call_id: pendingPlanApprovalCall.id, content: planApprovalBlockedMessage(error, session.toolPermissionContext.planFilePath) });
          continue;
        }
      }
    }

    return { session: { ...session, messages, status: "idle_input" } };
  }
}



async function prepareInitialPlanWrite(
  session: KernelSession,
  calls: ModelToolCall[],
  assistantContent: string | undefined,
  messages: ModelMessage[]
): Promise<{ session: KernelSession; calls: ModelToolCall[] }> {
  const planState = session.planState;
  const currentPlanFilePath = planState?.planFilePath;
  if (session.toolPermissionContext.mode !== "plan" || !planState || !currentPlanFilePath) return { session, calls };
  if (planState.planFileFinalized === true || !isDefaultPlanFilePath(currentPlanFilePath)) return { session, calls };

  const existing = await readPlan(currentPlanFilePath);
  if (existing !== undefined) {
    return { session: { ...session, planState: { ...planState, planFileFinalized: true } }, calls };
  }

  const writeIndex = calls.findIndex((call) => call.name === "Write" && callInputPathMatchesPlan(call.input, currentPlanFilePath, session.cwd));
  if (writeIndex < 0) return { session, calls };

  const writeCall = calls[writeIndex]!;
  const writeInput = objectInput(writeCall.input);
  const planContent = typeof writeInput?.content === "string" ? writeInput.content : undefined;
  const slug = planFilenameSlug(planContent, assistantContent);
  const nextPlanFilePath = await uniquePlanFilePath(currentPlanFilePath, slug);
  const nextPlanState = { ...planState, planFilePath: nextPlanFilePath, planFileFinalized: true };
  const nextPermissions = { ...session.toolPermissionContext, planFilePath: nextPlanFilePath };
  const nextCalls = calls.slice();
  nextCalls[writeIndex] = { ...writeCall, input: { ...writeInput, file_path: nextPlanFilePath } };
  replacePlanFilePathInMessages(messages, currentPlanFilePath, nextPlanFilePath);
  return { session: { ...session, planState: nextPlanState, toolPermissionContext: nextPermissions }, calls: nextCalls };
}

function callInputPathMatchesPlan(input: unknown, planFilePath: string, cwd: string): boolean {
  const value = objectInput(input)?.file_path;
  if (typeof value !== "string" || !value.trim()) return false;
  const target = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const plan = isAbsolute(planFilePath) ? resolve(planFilePath) : resolve(cwd, planFilePath);
  return target === plan;
}

function replacePlanFilePathInMessages(messages: ModelMessage[], from: string, to: string): void {
  for (const message of messages) {
    if (typeof message.content === "string") {
      message.content = message.content.split(from).join(to);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.map((part) => {
      if (part.type !== "text") return part;
      return { ...part, text: part.text.split(from).join(to) };
    });
  }
}

async function buildQueryMessages(session: KernelSession, tools: KernelToolRegistry, input: Pick<QueryEngineInput, "globalPrompt">): Promise<ModelMessage[]> {
  const messages = closeDanglingExitPlanModeToolCalls(session.messages, planApprovalToolResultContent({ decision: "repair" }));
  const attachments: RuntimeAttachment[] = [];
  if (!hasRuntimeAttachment(messages, "global_prompt")) {
    const globalPrompt = buildGlobalPromptAttachment(input.globalPrompt);
    if (globalPrompt) attachments.push(globalPrompt);
  }
  if (!hasRuntimeAttachment(messages, "tool_prompts")) {
    const toolPrompts = buildToolPromptsAttachment({ tools: tools.visibleTools(session.toolPermissionContext).map((tool) => tool.legacyTool) });
    if (toolPrompts) attachments.push(toolPrompts);
  }
  if (session.toolPermissionContext.mode === "plan" && session.toolPermissionContext.planFilePath && !hasRuntimeAttachment(messages, "plan_mode")) {
    const draft = await readPlan(session.toolPermissionContext.planFilePath);
    if (session.planState?.reentry && draft !== undefined && !hasRuntimeAttachment(messages, "plan_mode_reentry")) {
      attachments.push(buildPlanModeReentryAttachment({ planFilePath: session.toolPermissionContext.planFilePath }));
    }
    attachments.push(buildPlanModeAttachment({
      sessionId: session.id,
      planFilePath: session.toolPermissionContext.planFilePath,
      draft
    }));
  }
  return attachments.length ? withRuntimeAttachments(messages, attachments) : messages.slice();
}

async function callsUntilUserInteraction(calls: ModelToolCall[], tools: KernelToolRegistry, session: KernelSession): Promise<ModelToolCall[]> {
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const interaction = await tools.get(call.name).requiresUserInteraction(call.input, {
      cwd: session.cwd,
      sessionId: session.id,
      planState: session.planState ?? undefined
    });
    if (!interaction) continue;
    return call.name === "ExitPlanMode" ? calls.slice(0, index + 1) : [call];
  }
  return calls;
}

function planApprovalBlockedMessage(error: unknown, planFilePath?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const path = planFilePath ? ` Current plan file: ${planFilePath}.` : "";
  return `${detail}${path} Stay in Plan Mode, write the plan file, then call ExitPlanMode again.`;
}

function questionsFromResult(result: { data?: unknown }): unknown[] {
  const data = result.data as { questions?: unknown } | undefined;
  return Array.isArray(data?.questions) ? data.questions : [];
}

function exitPlanRequest(input: unknown): { requestedPermissions?: { tool: string; prompt: string }[] } {
  const value = objectInput(input) as { allowedPrompts?: unknown } | undefined;
  if (!value) return {};
  return {
    requestedPermissions: Array.isArray(value.allowedPrompts) ? value.allowedPrompts.filter(isRequestedPermission) : undefined
  };
}

function objectInput(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function permissionDeniedMessage(toolName: string, reason: string): string {
  return `Permission denied for ${toolName}: ${reason}`;
}

function promptInjectionRecord(input: QueryEngineInput, requestMessages: ModelMessage[]): PromptInjectionRecord | undefined {
  const available = Boolean(input.globalPrompt?.trim());
  const presentInRequest = hasRuntimeAttachment(requestMessages, "global_prompt");
  if (!available && !presentInRequest) return undefined;
  const originalHadPrompt = hasRuntimeAttachment(input.session.messages, "global_prompt");
  const metadata = input.globalPromptMetadata ?? (input.globalPrompt ? promptTextSummary(input.globalPrompt.trim()) : undefined);
  return {
    type: "global_prompt",
    recordedAt: new Date().toISOString(),
    available,
    presentInRequest,
    injectedThisTurn: !originalHadPrompt && presentInRequest,
    ...(metadata?.sha256 ? { sha256: metadata.sha256 } : {}),
    ...(metadata?.chars !== undefined ? { chars: metadata.chars } : {}),
    ...(metadata?.lines !== undefined ? { lines: metadata.lines } : {}),
    ...(input.globalPromptMetadata?.sources ? { sources: input.globalPromptMetadata.sources } : {})
  };
}

function promptTextSummary(content: string): { sha256: string; chars: number; lines: number } {
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    chars: content.length,
    lines: content ? content.split(/\r?\n/).length : 0
  };
}

async function emit(input: QueryEngineInput, event: RuntimeEvent): Promise<void> {
  await input.eventSink?.(event);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("QueryEngine aborted");
  error.name = "AbortError";
  throw error;
}

function isRequestedPermission(value: unknown): value is { tool: string; prompt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { tool?: unknown; prompt?: unknown };
  return typeof item.tool === "string" && typeof item.prompt === "string";
}

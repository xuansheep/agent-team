import { createHash } from "node:crypto";
import type { AuditEvent } from "../audit/auditEvent.js";
import { ModelMessage, ModelRequest, ModelResponse, ModelStreamEvent, ModelToolCall } from "../providers/types.js";
import { hasModelUsage } from "../model/usage.js";
import { buildGlobalPromptAttachment, buildPlanModeAttachment, buildPlanModeReentryAttachment, buildToolPromptsAttachment, hasRuntimeAttachment, RuntimeAttachment } from "../context/attachments.js";
import { withRuntimeAttachments } from "../context/messages.js";
import { readPlan } from "../plans/planFiles.js";
import { exitPlanMode, type PlanRequestedPermission, type PlanSessionState } from "../plans/planSession.js";
import { PermissionKernel } from "../kernel/permissions/permissionKernel.js";
import { createKernelToolRegistry } from "../kernel/tools/registry.js";
import { executeToolCalls } from "../tools/orchestration.js";
import { Tool, ToolResult } from "../tools/types.js";
import { skillSystemMessageFromToolResult } from "../skills/skillTools.js";
import type { HookEvent, HookRunResult } from "../hooks/types.js";
import { PlanApprovalRequest, PromptInjectionRecord, RuntimeEvent, RuntimeTurnInput, RuntimeTurnResult, RuntimeUserInputRequest } from "./types.js";

const maxToolIterations = 20;
const planModeAttachmentConfig = {
  turnsBetweenAttachments: 5,
  fullReminderEveryAttachments: 5
} as const;
export class RuntimeTurnExecutor {
  async requestModel(input: RuntimeModelTurnInput): Promise<RuntimeModelTurnResult> {
    const streamed = Boolean(input.provider.stream);
    if (!input.provider.stream) return { streamed, response: await input.provider.generate(input.request) };

    const response = await input.provider.stream(input.request, (event) => {
      input.onStreamEvent?.(event);
    });
    return { streamed, response };
  }

  async execute(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    const messages = await buildTurnMessages(input);
    const userPromptHook = await runUserPromptSubmitHook(input, messages);
    if (userPromptHook.blockingErrors.length || userPromptHook.preventContinuation) {
      return { status: "failed", error: hookFailureMessage(userPromptHook), messages };
    }
    const kernelTools = createKernelToolRegistry(input.tools);
    const permissionKernel = new PermissionKernel();
    const promptInjection = promptInjectionRecord(input, messages);
    if (promptInjection) await emit(input, { type: "runtime_prompt_injection", session_id: input.sessionId, run_id: input.runId, record: promptInjection });
    await emit(input, { type: "runtime_turn_started", session_id: input.sessionId, run_id: input.runId });
    try {
      for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
        throwIfAborted(input.abortSignal);
        const { response } = await this.requestModel({
        provider: input.provider,
        request: {
          model: input.model,
          messages,
          tools: modelVisibleTools(input),
          context: {
            runId: input.runId ?? input.sessionId,
            nodeId: "runtime",
            attempt: iteration + 1,
            sessionId: input.sessionId,
            threadId: input.sessionId,
            turnId: `${input.sessionId}:${iteration + 1}`,
            promptCacheKey: input.sessionId
          },
          signal: input.abortSignal
        }
      });
      throwIfAborted(input.abortSignal);

      await emitModelUsage(input, input.model, response);
      if (!response.tool_calls?.length) {
        if (response.content !== undefined) {
          messages.push({ role: "assistant", content: response.content });
          await emit(input, { type: "runtime_assistant_message", session_id: input.sessionId, run_id: input.runId, content: response.content });
        }
        const stopHook = await runStopHook(input, messages);
        if (stopHook.blockingErrors.length || stopHook.preventContinuation) {
          messages.push({ role: "user", content: hookFailureMessage(stopHook) });
          continue;
        }
        return { status: "completed", messages };
      }
      const toolCalls = await executableToolCalls(response.tool_calls, input.tools);
      messages.push({ role: "assistant", content: response.content ?? "", tool_calls: toolCalls });
      await emit(input, { type: "runtime_assistant_message", session_id: input.sessionId, run_id: input.runId, content: response.content ?? "" });

      const permissionResults: Array<{ call: ModelToolCall; decision: "allow" | "deny"; error?: string }> = [];
      let planModePermissionBlocked = false;
      let pendingPlanApprovalCall: ModelToolCall | undefined;

      for (const call of toolCalls) {
        throwIfAborted(input.abortSignal);
        const preToolHook = await runToolHook("PreToolUse", input, call);
        if (preToolHook.updatedInput) call.input = preToolHook.updatedInput;
        if (preToolHook.blockingErrors.length || preToolHook.preventContinuation || preToolHook.permissionBehavior === "deny") {
          const error = hookFailureMessage(preToolHook);
          permissionResults.push({ call, decision: "deny", error });
          if (input.permissions.mode === "plan") planModePermissionBlocked = true;
          continue;
        }
        const permission = await permissionKernel.check(kernelTools.get(call.name), call.input, { ...input.permissions, cwd: input.cwd });
        await audit(input, {
          type: "permission_decision",
          tool: call.name,
          decision: permission.decision,
          reason: permission.reason,
          rule: permission.rule,
          input: call.input
        });
        if (permission.decision === "ask") {
          if (input.permissions.mode === "plan") {
            if (call.name === "ExitPlanMode") {
              pendingPlanApprovalCall = call;
              permissionResults.push({ call, decision: "allow" });
              continue;
            }
            const error = permissionDeniedMessage(call.name, permission.reason ?? permission.rule ?? "interactive permission required");
            permissionResults.push({ call, decision: "deny", error });
            planModePermissionBlocked = true;
            continue;
          }
          const request = { sessionId: input.sessionId, runId: input.runId, tool: call.name, input: call.input, reason: permission.reason, rule: permission.rule };
          await emit(input, { type: "runtime_permission_requested", session_id: input.sessionId, run_id: input.runId, tool: call.name, input: call.input, reason: permission.reason, rule: permission.rule });
          if (!input.permissionCallback) return { status: "waiting_permission", messages, request };
          const decision = await input.permissionCallback(request);
          await emit(input, { type: "runtime_permission_resolved", session_id: input.sessionId, run_id: input.runId, tool: call.name, decision });
          await audit(input, {
            type: "permission_decision",
            tool: call.name,
            decision,
            reason: "permission callback",
            rule: permission.rule,
            input: call.input
          });
          if (decision === "deny") {
            const error = permissionDeniedMessage(call.name, "callback denied");
            await emit(input, { type: "runtime_tool_failed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, error });
            return { status: "failed", error, messages };
          }
        }
        if (permission.decision === "deny") {
          const error = permissionDeniedMessage(call.name, permission.reason ?? permission.rule ?? "no rule");
          if (input.permissions.mode === "plan") {
            permissionResults.push({ call, decision: "deny", error });
            planModePermissionBlocked = true;
            continue;
          }
          await emit(input, { type: "runtime_tool_failed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, error });
          return { status: "failed", error, messages };
        }
        permissionResults.push({ call, decision: "allow" });
      }

      if (planModePermissionBlocked) {
        for (const result of permissionResults) {
          if (result.decision === "deny") {
            const error = result.error ?? permissionDeniedMessage(result.call.name, "Permission denied");
            messages.push(permissionDeniedToolMessage(result.call.id, error));
            continue;
          }
          messages.push(skippedPlanModeToolMessage(result.call.id, result.call.name));
        }
        continue;
      }

      const callsToExecute = pendingPlanApprovalCall
        ? toolCalls.slice(0, toolCalls.indexOf(pendingPlanApprovalCall))
        : toolCalls;
      const executions = await executeToolCalls(callsToExecute, input.tools, {
        cwd: input.cwd,
        sessionId: input.sessionId,
        runId: input.runId,
        planState: input.planState,
        abortSignal: input.abortSignal,
        nodeId: "runtime",
        attempt: iteration + 1,
        auditSink: input.auditSink
      }, {
        onToolStart: (call) => emit(input, { type: "runtime_tool_invoked", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, input: call.input }),
        onToolComplete: async (call, result) => {
          await emit(input, { type: "runtime_tool_completed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, result });
          await runToolHook("PostToolUse", input, call, result);
        },
        onToolError: async (call, error) => {
          await emit(input, { type: "runtime_tool_failed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, error });
          await runToolHook("PostToolUseFailure", input, call, undefined, error);
        }
      });
      throwIfAborted(input.abortSignal);
      for (const execution of executions) {
        throwIfAborted(input.abortSignal);
        const userInput = userInputFromToolResult(execution.call.id, execution.result, input);
        if (userInput) {
          await emit(input, { type: "runtime_user_input_requested", session_id: input.sessionId, run_id: input.runId, tool_call_id: userInput.toolCallId, questions: userInput.questions });
          return { status: "waiting_user_input", messages, request: userInput };
          }
          const tool = input.tools.get(execution.call.name);
          messages.push(execution.result ? toolMessage(execution.call.id, execution.result, tool) : { role: "tool", tool_call_id: execution.call.id, content: JSON.stringify({ error: execution.error ?? "Tool failed" }) });
          const skillMessage = skillSystemMessageFromToolResult(execution.result);
          if (skillMessage) messages.push(skillMessage);
          const planApproval = planApprovalFromToolResult(execution.result);
        if (planApproval) {
          await emit(input, planApproval.event);
          return { status: "waiting_plan_approval", messages, plan: planApproval.plan, planState: planApproval.state, usage: response.usage };
        }
      }

      if (pendingPlanApprovalCall) {
        try {
          const planApproval = await requestPlanApprovalFromRuntime(input, pendingPlanApprovalCall.input);
          messages.push(planApproval.toolMessage(pendingPlanApprovalCall.id));
          await emit(input, planApproval.event);
          return { status: "waiting_plan_approval", messages, plan: planApproval.plan, planState: planApproval.state, usage: response.usage };
        } catch (error) {
          messages.push({ role: "tool", tool_call_id: pendingPlanApprovalCall.id, content: planApprovalBlockedMessage(error, input.permissions.planFilePath) });
          continue;
        }
      }
    }

      return { status: "failed", error: `Exceeded ${maxToolIterations} tool iterations`, messages };
    } catch (error) {
      if (isAbortLikeError(error) || input.abortSignal?.aborted) return { status: "aborted", messages };
      throw error;
    }
  }
}


async function runUserPromptSubmitHook(input: RuntimeTurnInput, messages: ModelMessage[]): Promise<HookRunResult> {
  const prompt = lastUserMessageText(messages);
  const result = await runHook(input, "UserPromptSubmit", { prompt });
  appendHookContext(messages, result);
  return result;
}

async function runStopHook(input: RuntimeTurnInput, messages: ModelMessage[]): Promise<HookRunResult> {
  const result = await runHook(input, "Stop", { messages: messages.map((message) => ({ role: message.role, content: message.content })) });
  appendHookContext(messages, result);
  return result;
}

async function runToolHook(
  event: HookEvent,
  input: RuntimeTurnInput,
  call: ModelToolCall,
  result?: ToolResult,
  error?: string
): Promise<HookRunResult> {
  return runHook(input, event, {
    tool_name: call.name,
    tool_input: call.input,
    tool_call_id: call.id,
    ...(result ? { tool_response: result } : {}),
    ...(error ? { error } : {})
  });
}

async function runHook(input: RuntimeTurnInput, event: HookEvent, hookInput: Record<string, unknown>): Promise<HookRunResult> {
  const empty: HookRunResult = { event, executed: 0, blockingErrors: [], nonBlockingErrors: [], additionalContexts: [], systemMessages: [] };
  if (!input.hookRuntime) return empty;
  return input.hookRuntime.run(event, hookInput, {
    cwd: input.cwd,
    sessionId: input.sessionId,
    runId: input.runId,
    permissionMode: input.permissions.mode,
    provider: input.provider,
    model: input.model,
    tools: input.tools.list(),
    signal: input.abortSignal
  });
}

function appendHookContext(messages: ModelMessage[], result: HookRunResult): void {
  for (const systemMessage of result.systemMessages) messages.push({ role: "system", content: systemMessage });
  for (const context of result.additionalContexts) messages.push({ role: "system", content: context });
}

function hookFailureMessage(result: HookRunResult): string {
  const detail = result.blockingErrors.map((error) => error.blockingError).filter(Boolean).join("; ");
  return detail || result.stopReason || `Hook ${result.event} blocked continuation`;
}

function lastUserMessageText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }
  return "";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Runtime turn aborted");
  error.name = "AbortError";
  throw error;
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function modelVisibleTools(input: RuntimeTurnInput): Tool[] {
  return createKernelToolRegistry(input.tools).visibleTools(input.permissions).map((tool) => tool.legacyTool);
}

function promptInjectionRecord(input: RuntimeTurnInput, requestMessages: ModelMessage[]): PromptInjectionRecord | undefined {
  const available = Boolean(input.globalPrompt?.trim());
  const presentInRequest = hasRuntimeAttachment(requestMessages, "global_prompt");
  if (!available && !presentInRequest) return undefined;
  const originalHadPrompt = hasRuntimeAttachment(input.messages, "global_prompt");
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

async function executableToolCalls(calls: ModelToolCall[], tools: RuntimeTurnInput["tools"]): Promise<ModelToolCall[]> {
  const interactionCall = await firstUserInteractionTool(calls, tools);
  if (!interactionCall) return calls;
  return interactionCall.name === "ExitPlanMode" ? calls.slice(0, calls.indexOf(interactionCall) + 1) : [interactionCall];
}

async function firstUserInteractionTool(calls: ModelToolCall[], tools: RuntimeTurnInput["tools"]): Promise<ModelToolCall | undefined> {
  for (const call of calls) {
    if (await tools.get(call.name).requiresUserInteraction?.(call.input)) return call;
  }
  return undefined;
}

async function buildTurnMessages(input: RuntimeTurnInput): Promise<ModelMessage[]> {
  const messages = input.messages.slice();
  const globalPromptAttachment = hasRuntimeAttachment(messages, "global_prompt")
    ? undefined
    : buildGlobalPromptAttachment(input.globalPrompt);
  const toolPromptAttachment = hasRuntimeAttachment(messages, "tool_prompts")
    ? undefined
    : buildToolPromptsAttachment({ tools: modelVisibleTools(input) });
  if (input.permissions.mode !== "plan" || !input.permissions.planFilePath) {
    const attachments: RuntimeAttachment[] = [];
    if (globalPromptAttachment) attachments.push(globalPromptAttachment);
    if (toolPromptAttachment) attachments.push(toolPromptAttachment);
    return attachments.length ? withRuntimeAttachments(messages, attachments) : messages;
  }

  const attachmentTiming = planModeAttachmentTiming(messages);
  const draft = attachmentTiming.hasPlanAttachment ? undefined : await readPlan(input.permissions.planFilePath);
  const attachments: RuntimeAttachment[] = [];
  if (globalPromptAttachment) attachments.push(globalPromptAttachment);
  if (toolPromptAttachment) attachments.push(toolPromptAttachment);
  if (input.planState?.reentry && !hasRuntimeAttachment(messages, "plan_mode_reentry") && draft !== undefined) {
    attachments.push(buildPlanModeReentryAttachment({ planFilePath: input.permissions.planFilePath }));
  }
  if (attachmentTiming.skip) {
    return attachments.length ? withRuntimeAttachments(messages, attachments) : messages;
  }
  attachments.push(buildPlanModeAttachment({
    sessionId: input.sessionId,
    planFilePath: input.permissions.planFilePath,
    draft,
    sparse: attachmentTiming.sparse
  }));
  return withRuntimeAttachments(messages, attachments);
}

function planModeAttachmentTiming(messages: ModelMessage[]): { hasPlanAttachment: boolean; skip: boolean; sparse: boolean } {
  const annotatedTiming = annotatedPlanModeAttachmentTiming(messages);
  if (annotatedTiming) return annotatedTiming;

  let humanTurnsSinceAttachment = 0;
  let planAttachmentsSinceExit = 0;
  let foundLatestPlanAttachment = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const marker = runtimeAttachmentMarker(message);
    if (marker === "plan_mode_exit") break;
    if (marker === "plan_mode" || marker === "plan_mode_reminder") {
      planAttachmentsSinceExit += 1;
      if (!foundLatestPlanAttachment) foundLatestPlanAttachment = true;
      continue;
    }
    if (marker === "plan_mode_reentry" && !foundLatestPlanAttachment) {
      foundLatestPlanAttachment = true;
      continue;
    }
    if (!foundLatestPlanAttachment && isHumanTurn(message)) humanTurnsSinceAttachment += 1;
  }

  if (foundLatestPlanAttachment && humanTurnsSinceAttachment < planModeAttachmentConfig.turnsBetweenAttachments) return { hasPlanAttachment: true, skip: true, sparse: true };
  const nextPlanAttachmentCount = planAttachmentsSinceExit + 1;
  return {
    hasPlanAttachment: foundLatestPlanAttachment,
    skip: false,
    sparse: nextPlanAttachmentCount % planModeAttachmentConfig.fullReminderEveryAttachments !== 1
  };
}

function annotatedPlanModeAttachmentTiming(messages: ModelMessage[]): { hasPlanAttachment: boolean; skip: boolean; sparse: boolean } | undefined {
  const annotatedAttachments = messages.flatMap((message) => {
    const attachment = message.metadata?.runtimeAttachment;
    if (!attachment) return [];
    return [{ type: attachment.type, humanTurnCount: attachment.humanTurnCount }];
  });
  if (!annotatedAttachments.length) return undefined;

  const totalHumanTurns = messages.filter(isHumanTurn).length;
  const lastExitTurn = Math.max(
    -1,
    ...annotatedAttachments
      .filter((attachment) => attachment.type === "plan_mode_exit")
      .map((attachment) => attachment.humanTurnCount)
  );
  const planAttachments = annotatedAttachments.filter((attachment) =>
    attachment.humanTurnCount > lastExitTurn &&
    (attachment.type === "plan_mode" || attachment.type === "plan_mode_reminder" || attachment.type === "plan_mode_reentry")
  );
  const latestPlanAttachmentTurn = Math.max(-1, ...planAttachments.map((attachment) => attachment.humanTurnCount));
  const foundLatestPlanAttachment = latestPlanAttachmentTurn >= 0;
  const planAttachmentsSinceExit = messages.filter((message) => {
    const annotated = message.metadata?.runtimeAttachment;
    const marker = runtimeAttachmentMarker(message);
    if (annotated) {
      return annotated.humanTurnCount > lastExitTurn &&
        (annotated.type === "plan_mode" || annotated.type === "plan_mode_reminder");
    }
    return lastExitTurn < 0 && (marker === "plan_mode" || marker === "plan_mode_reminder");
  }).length;

  if (foundLatestPlanAttachment && totalHumanTurns - latestPlanAttachmentTurn < planModeAttachmentConfig.turnsBetweenAttachments) {
    return { hasPlanAttachment: true, skip: true, sparse: true };
  }
  const nextPlanAttachmentCount = planAttachmentsSinceExit + 1;
  return {
    hasPlanAttachment: foundLatestPlanAttachment,
    skip: false,
    sparse: nextPlanAttachmentCount % planModeAttachmentConfig.fullReminderEveryAttachments !== 1
  };
}

function runtimeAttachmentMarker(message: ModelMessage): "plan_mode" | "plan_mode_reminder" | "plan_mode_reentry" | "plan_mode_exit" | undefined {
  if (typeof message.content !== "string") return undefined;
  const match = /(?:^|\n)ATTACHMENT (plan_mode|plan_mode_reminder|plan_mode_reentry|plan_mode_exit)\b/.exec(message.content);
  return match?.[1] as ReturnType<typeof runtimeAttachmentMarker>;
}

function isHumanTurn(message: ModelMessage): boolean {
  return message.role === "user" && !message.metadata?.runtimeAttachment;
}

function toolMessage(toolCallId: string, result: ToolResult, tool: Tool): ModelMessage {
  const mapped = tool.mapToolResultToModelResult?.(result);
  return { role: "tool", tool_call_id: toolCallId, content: typeof mapped === "string" ? mapped : JSON.stringify(mapped ?? result) };
}

function permissionDeniedMessage(toolName: string, reason: string): string {
  return `Permission denied for ${toolName}: ${reason}`;
}

function permissionDeniedToolMessage(toolCallId: string, error: string): ModelMessage {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify({ error, permission_denied: true }) };
}

function skippedPlanModeToolMessage(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({
      skipped: true,
      reason: `Skipped ${toolName} because another Plan Mode tool call was denied. Re-plan using only read-only tools or the current plan file.`
    })
  };
}

function planApprovalBlockedMessage(error: unknown, planFilePath?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const path = planFilePath ? ` Current plan file: ${planFilePath}.` : "";
  return `${detail}${path} Stay in Plan Mode, write the plan file, then call ExitPlanMode again.`;
}

async function requestPlanApprovalFromRuntime(input: RuntimeTurnInput, toolInput: unknown): Promise<{
  state: PlanSessionState;
  plan: PlanApprovalRequest;
  event: Extract<RuntimeEvent, { type: "plan_approval_requested" }>;
  toolMessage: (toolCallId: string) => ModelMessage;
}> {
  if (!input.planState) throw new Error("Plan Mode is not active");
  const result = await exitPlanMode(input.planState, exitPlanRequest(toolInput));
  return {
    state: result.state,
    plan: result.plan,
    event: result.event as Extract<RuntimeEvent, { type: "plan_approval_requested" }>,
    toolMessage: (toolCallId) => toolMessage(toolCallId, { output: `Plan approval requested for ${result.plan.sessionId}`, data: result }, input.tools.get("ExitPlanMode"))
  };
}

function exitPlanRequest(input: unknown): { requestedPermissions?: PlanRequestedPermission[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as { allowedPrompts?: unknown };
  return {
    requestedPermissions: Array.isArray(value.allowedPrompts) ? value.allowedPrompts.filter(isRequestedPermission) : undefined
  };
}

function isRequestedPermission(value: unknown): value is PlanRequestedPermission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { tool?: unknown; prompt?: unknown };
  return item.tool === "Bash" && typeof item.prompt === "string";
}

function planApprovalFromToolResult(result: ToolResult | undefined): { state: PlanSessionState; plan: PlanApprovalRequest; event: Extract<RuntimeEvent, { type: "plan_approval_requested" }> } | undefined {
  const data = result?.data as { state?: unknown; plan?: unknown; event?: unknown } | undefined;
  if (!data || !data.event || typeof data.event !== "object") return undefined;
  const event = data.event as { type?: unknown };
  if (event.type !== "plan_approval_requested") return undefined;
  return data as { state: PlanSessionState; plan: PlanApprovalRequest; event: Extract<RuntimeEvent, { type: "plan_approval_requested" }> };
}

function userInputFromToolResult(toolCallId: string, result: ToolResult | undefined, input: RuntimeTurnInput): RuntimeUserInputRequest | undefined {
  const data = result?.data as { type?: unknown; questions?: unknown } | undefined;
  if (data?.type !== "user_input_requested" || !Array.isArray(data.questions)) return undefined;
  return { sessionId: input.sessionId, runId: input.runId, toolCallId, questions: data.questions };
}

async function emit(input: RuntimeTurnInput, event: RuntimeEvent): Promise<void> {
  await input.eventSink?.(event);
  await auditPlanModeEvent(input, event);
}

async function emitModelUsage(input: RuntimeTurnInput, model: string, response: ModelResponse): Promise<void> {
  if (!hasModelUsage(response.usage)) return;
  await emit(input, {
    type: "runtime_model_usage",
    session_id: input.sessionId,
    run_id: input.runId,
    model,
    usage: response.usage,
    stop_reason: response.stopReason
  });
}

async function audit(input: RuntimeTurnInput, event: AuditEvent): Promise<void> {
  await input.auditSink?.({ ...event, session_id: event.session_id ?? input.sessionId, run_id: event.run_id ?? input.runId });
}

async function auditPlanModeEvent(input: RuntimeTurnInput, event: RuntimeEvent): Promise<void> {
  if (event.type === "plan_mode_entered") {
    await audit(input, { type: "plan_mode", action: "entered", plan_file_path: event.plan_file_path });
  }
  if (event.type === "plan_draft_updated") {
    await audit(input, { type: "plan_mode", action: "draft_updated", plan_file_path: event.plan_file_path });
  }
  if (event.type === "plan_approval_requested") {
    await audit(input, { type: "plan_mode", action: "approval_requested", plan_file_path: event.plan_file_path });
  }
  if (event.type === "plan_approval_resolved") {
    await audit(input, { type: "plan_mode", action: "approval_resolved", decision: event.decision });
  }
}

export type RuntimeModelTurnInput = {
  provider: RuntimeTurnInput["provider"];
  request: ModelRequest;
  onStreamEvent?: (event: ModelStreamEvent) => void;
};

export type RuntimeModelTurnResult = {
  streamed: boolean;
  response: ModelResponse;
};

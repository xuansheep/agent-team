import { buildPlanModeAttachment, buildToolPromptsAttachment, hasRuntimeAttachment, type RuntimeAttachment } from "../context/attachments.js";
import { withRuntimeAttachments } from "../context/messages.js";
import { readPlan } from "../plans/planFiles.js";
import { normalizePlanModeToolCalls } from "../plans/planToolInput.js";
import { isBlockedPlanModePlainText, isPlanModeRepairToolResult, isSourceEditPermissionQuestion, planModeNoToolReminder, sourceEditPermissionQuestionMessage } from "../plans/planGuards.js";
import type { ModelMessage, ModelProvider, ModelToolCall } from "../providers/types.js";
import { PermissionKernel } from "./permissions/permissionKernel.js";
import { PlanModeController } from "./plan/planModeController.js";
import type { KernelSession } from "./session.js";
import { reduceKernelSession } from "./session.js";
import type { KernelToolRegistry } from "./tools/registry.js";

const maxToolIterations = 20;

export type QueryEngineInput = {
  session: KernelSession;
  provider: ModelProvider;
  model: string;
  tools: KernelToolRegistry;
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
    const messages = await buildQueryMessages(session, input.tools);
    let planModePlainTextRepairCount = 0;

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const response = await input.provider.generate({
        model: input.model,
        messages,
        tools: input.tools.visibleTools(session.toolPermissionContext).map((tool) => tool.legacyTool),
        context: {
          runId: session.workflowBinding?.runId ?? session.id,
          nodeId: "kernel",
          attempt: iteration + 1,
          sessionId: session.id,
          threadId: session.id,
          turnId: `${session.id}:${iteration + 1}`,
          promptCacheKey: session.id
        }
      });

      if (!response.tool_calls?.length) {
        if (response.content !== undefined) messages.push({ role: "assistant", content: response.content });
        if (session.toolPermissionContext.mode === "plan" && session.planState?.mode === "planning" && (isBlockedPlanModePlainText(response.content) || previousMessageRequiresPlanModeRepair(messages))) {
          if (planModePlainTextRepairCount < 2) {
            planModePlainTextRepairCount += 1;
            messages.push({ role: "system", content: planModeNoToolReminder(session.toolPermissionContext.planFilePath) });
            continue;
          }
        }
        return { session: { ...session, messages, status: "idle_input" } };
      }
      planModePlainTextRepairCount = 0;

      const calls = normalizePlanModeToolCalls(
        await callsUntilUserInteraction(response.tool_calls, input.tools, session),
        session.toolPermissionContext.mode === "plan" ? session.toolPermissionContext.planFilePath : undefined
      );
      messages.push({ role: "assistant", content: response.content ?? "", tool_calls: calls });

      let pendingPlanApprovalCall: ModelToolCall | undefined;
      let planModePermissionBlocked = false;
      for (const call of calls) {
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
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: permission.reason ?? "Permission denied", permission_denied: true }) });
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
        const context = { cwd: session.cwd, sessionId: session.id, planState: session.planState ?? undefined };
        const interaction = await tool.requiresUserInteraction(call.input, context);
        if (interaction?.type === "ask_user_question") {
          const result = await tool.execute(call.input, context);
          if (session.toolPermissionContext.mode === "plan" && call.name === "AskUserQuestion" && isSourceEditPermissionQuestion(call.input)) {
            messages.push({ role: "tool", tool_call_id: call.id, content: sourceEditPermissionQuestionMessage(session.toolPermissionContext.planFilePath) });
            continue;
          }
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
            return { session: await this.planMode.requestPlanApproval({ ...session, messages }, request) };
          } catch (error) {
            messages.push({ role: "tool", tool_call_id: call.id, content: planApprovalBlockedMessage(error, session.toolPermissionContext.planFilePath) });
            continue;
          }
        }
        const result = await tool.execute(call.input, context);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(tool.mapToolResultToModelResult(result, context)) });
      }
      if (pendingPlanApprovalCall) {
        const request = exitPlanRequest(pendingPlanApprovalCall.input);
        try {
          return { session: await this.planMode.requestPlanApproval({ ...session, messages }, request) };
        } catch (error) {
          messages.push({ role: "tool", tool_call_id: pendingPlanApprovalCall.id, content: planApprovalBlockedMessage(error, session.toolPermissionContext.planFilePath) });
          continue;
        }
      }
    }

    return { session: { ...session, messages, status: "idle_input" } };
  }
}

async function buildQueryMessages(session: KernelSession, tools: KernelToolRegistry): Promise<ModelMessage[]> {
  const attachments: RuntimeAttachment[] = [];
  if (!hasRuntimeAttachment(session.messages, "tool_prompts")) {
    const toolPrompts = buildToolPromptsAttachment({ tools: tools.visibleTools(session.toolPermissionContext).map((tool) => tool.legacyTool) });
    if (toolPrompts) attachments.push(toolPrompts);
  }
  if (session.toolPermissionContext.mode === "plan" && session.toolPermissionContext.planFilePath && !hasRuntimeAttachment(session.messages, "plan_mode")) {
    attachments.push(buildPlanModeAttachment({
      sessionId: session.id,
      planFilePath: session.toolPermissionContext.planFilePath,
      draft: await readPlan(session.toolPermissionContext.planFilePath)
    }));
  }
  return attachments.length ? withRuntimeAttachments(session.messages, attachments) : session.messages.slice();
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

function previousMessageRequiresPlanModeRepair(messages: ModelMessage[]): boolean {
  const previous = messages.at(-2);
  return previous?.role === "tool" && isPlanModeRepairToolResult(previous.content);
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
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as { allowedPrompts?: unknown };
  return {
    requestedPermissions: Array.isArray(value.allowedPrompts) ? value.allowedPrompts.filter(isRequestedPermission) : undefined
  };
}

function isRequestedPermission(value: unknown): value is { tool: string; prompt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { tool?: unknown; prompt?: unknown };
  return typeof item.tool === "string" && typeof item.prompt === "string";
}

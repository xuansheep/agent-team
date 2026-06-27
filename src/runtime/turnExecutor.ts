import type { AuditEvent } from "../audit/auditEvent.js";
import { ModelMessage, ModelRequest, ModelResponse, ModelStreamEvent } from "../providers/types.js";
import { hasModelUsage } from "../model/usage.js";
import { buildPlanModeAttachment, hasRuntimeAttachment } from "../context/attachments.js";
import { withRuntimeAttachments } from "../context/messages.js";
import { readPlan } from "../plans/planFiles.js";
import { checkToolPermission } from "../permissions/checkToolPermission.js";
import { executeToolCalls } from "../tools/orchestration.js";
import { ToolResult } from "../tools/types.js";
import { RuntimeEvent, RuntimeTurnInput, RuntimeTurnResult } from "./types.js";

const maxToolIterations = 20;

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
    await emit(input, { type: "runtime_turn_started", session_id: input.sessionId, run_id: input.runId });

    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const { response } = await this.requestModel({
        provider: input.provider,
        request: {
          model: input.model,
          messages,
          tools: input.tools.list(),
          context: {
            runId: input.runId ?? input.sessionId,
            nodeId: "runtime",
            attempt: iteration + 1,
            sessionId: input.sessionId,
            threadId: input.sessionId,
            turnId: `${input.sessionId}:${iteration + 1}`,
            promptCacheKey: input.sessionId
          }
        }
      });

      await emitModelUsage(input, input.model, response);
      if (!response.tool_calls?.length) {
        if (response.content !== undefined) {
          messages.push({ role: "assistant", content: response.content });
          await emit(input, { type: "runtime_assistant_message", session_id: input.sessionId, run_id: input.runId, content: response.content });
        }
        return { status: "completed", messages };
      }

      messages.push({ role: "assistant", content: response.content ?? "", tool_calls: response.tool_calls });
      await emit(input, { type: "runtime_assistant_message", session_id: input.sessionId, run_id: input.runId, content: response.content ?? "" });

      for (const call of response.tool_calls) {
        const tool = input.tools.get(call.name);
        const permission = await checkToolPermission(tool, call.input, { ...input.permissions, cwd: input.cwd });
        await audit(input, {
          type: "permission_decision",
          tool: call.name,
          decision: permission.decision,
          reason: permission.reason,
          rule: permission.rule,
          input: call.input
        });
        if (permission.decision === "ask") {
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
            const error = `Permission denied for ${call.name}: callback denied`;
            await emit(input, { type: "runtime_tool_failed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, error });
            return { status: "failed", error, messages };
          }
        }
        if (permission.decision === "deny") {
          const error = `Permission denied for ${call.name}: ${permission.reason ?? permission.rule ?? "no rule"}`;
          await emit(input, { type: "runtime_tool_failed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, error });
          return { status: "failed", error, messages };
        }
      }

      const executions = await executeToolCalls(response.tool_calls, input.tools, {
        cwd: input.cwd,
        sessionId: input.sessionId,
        runId: input.runId,
        nodeId: "runtime",
        attempt: iteration + 1,
        auditSink: input.auditSink
      }, {
        onToolStart: (call) => emit(input, { type: "runtime_tool_invoked", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, input: call.input }),
        onToolComplete: (call, result) => emit(input, { type: "runtime_tool_completed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, result }),
        onToolError: (call, error) => emit(input, { type: "runtime_tool_failed", session_id: input.sessionId, run_id: input.runId, tool_call_id: call.id, tool: call.name, error })
      });
      for (const execution of executions) {
        messages.push(execution.result ? toolMessage(execution.call.id, execution.result) : { role: "tool", tool_call_id: execution.call.id, content: JSON.stringify({ error: execution.error ?? "Tool failed" }) });
      }
    }

    return { status: "failed", error: `Exceeded ${maxToolIterations} tool iterations`, messages };
  }
}

async function buildTurnMessages(input: RuntimeTurnInput): Promise<ModelMessage[]> {
  const messages = input.messages.slice();
  if (input.permissions.mode !== "plan" || !input.permissions.planFilePath) return messages;

  const sparse = hasRuntimeAttachment(messages, "plan_mode");
  const draft = sparse ? undefined : await readPlan(input.permissions.planFilePath);
  return withRuntimeAttachments(messages, [buildPlanModeAttachment({
    sessionId: input.sessionId,
    planFilePath: input.permissions.planFilePath,
    draft,
    sparse
  })]);
}

function toolMessage(toolCallId: string, result: ToolResult): ModelMessage {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(result) };
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

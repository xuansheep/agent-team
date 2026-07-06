import type { ModelMessage, ModelToolCall } from "../../providers/types.js";

const exitPlanModeToolName = "ExitPlanMode";

export function planApprovalToolResultContent(input: { decision: "continue" | "stay" | "cancel" | "repair"; feedback?: unknown }): string {
  if (input.decision === "continue") {
    return "Plan approved by the user. Continue with the implementation handoff.";
  }
  if (input.decision === "stay") {
    const feedback = feedbackText(input.feedback);
    return [
      "Plan approval was rejected by the user. Stay in Plan Mode, incorporate the feedback, update the plan file, then call ExitPlanMode again.",
      ...(feedback ? [`User feedback: ${feedback}`] : [])
    ].join("\n");
  }
  if (input.decision === "cancel") {
    return "Plan approval was cancelled. Stay in Plan Mode and wait for the user's next instruction before calling ExitPlanMode again.";
  }
  return "Plan approval did not complete. Stay in Plan Mode and continue from the user's next instruction before calling ExitPlanMode again.";
}

export function closeDanglingExitPlanModeToolCalls(messages: ModelMessage[], content: string): ModelMessage[] {
  const repaired: ModelMessage[] = [];
  const pending = new Map<string, ModelToolCall>();
  const synthesized = new Set<string>();
  let changed = false;

  const flush = () => {
    for (const call of pending.values()) {
      repaired.push({ role: "tool", tool_call_id: call.id, content });
      synthesized.add(call.id);
      changed = true;
    }
    pending.clear();
  };

  for (const message of messages) {
    if (message.role === "tool") {
      if (message.tool_call_id && synthesized.has(message.tool_call_id)) {
        changed = true;
        continue;
      }
      repaired.push(message);
      if (message.tool_call_id) pending.delete(message.tool_call_id);
      continue;
    }

    if (pending.size) flush();
    repaired.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call.name === exitPlanModeToolName) pending.set(call.id, call);
    }
  }

  if (pending.size) flush();
  return changed ? repaired : messages.slice();
}


function feedbackText(feedback: unknown): string | undefined {
  if (!feedback || typeof feedback !== "object") return typeof feedback === "string" && feedback.trim() ? feedback.trim() : undefined;
  const answer = (feedback as { answer?: unknown }).answer;
  return typeof answer === "string" && answer.trim() ? answer.trim() : undefined;
}

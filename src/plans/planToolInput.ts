import type { ModelToolCall } from "../providers/types.js";

export function normalizePlanModeToolCalls(calls: ModelToolCall[], _planFilePath: string | undefined): ModelToolCall[] {
  return calls;
}

export function normalizePlanModeToolCall(call: ModelToolCall, _planFilePath: string | undefined): ModelToolCall {
  return call;
}

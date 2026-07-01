import type { ModelToolCall } from "../providers/types.js";

const planModeWriteTools = new Set(["Write", "Edit", "MultiEdit"]);

export function normalizePlanModeToolCalls(calls: ModelToolCall[], planFilePath: string | undefined): ModelToolCall[] {
  return calls.map((call) => normalizePlanModeToolCall(call, planFilePath));
}

export function normalizePlanModeToolCall(call: ModelToolCall, planFilePath: string | undefined): ModelToolCall {
  if (!planFilePath || !planModeWriteTools.has(call.name)) return call;
  const input = call.input && typeof call.input === "object" && !Array.isArray(call.input)
    ? call.input as Record<string, unknown>
    : {};
  if (!shouldTargetCurrentPlanFile(input.file_path, planFilePath)) return call;
  return {
    ...call,
    input: { ...input, file_path: planFilePath }
  };
}

function shouldTargetCurrentPlanFile(filePath: unknown, planFilePath: string): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) return true;
  const inputPath = normalizePathForComparison(filePath);
  const planPath = normalizePathForComparison(planFilePath);
  return inputPath === planPath || (inputPath.length >= 3 && planPath.startsWith(inputPath));
}

function normalizePathForComparison(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

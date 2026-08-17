import { createHash } from "node:crypto";
import { failureFingerprint, toolFailureInfo } from "./errors.js";
import type { ToolResult } from "./types.js";

export const DETERMINISTIC_TOOL_FAILURE_CATEGORIES = {
  unknownTool: "tool.unknown",
  inputValidation: "tool.input.validation",
  staticPermissionDenied: "tool.permission.static_denied",
  planPolicyDenied: "tool.permission.plan_denied"
} as const;

export const REPEAT_BLOCKED_FAILURE_CATEGORY = "tool.repeat_blocked";
export type RepeatFailureMetadata = { failure_count: number; retry_blocked: boolean };
type FailureEntry = { category: string; count: number };

export class RepeatFailureGuard {
  private readonly failures = new Map<string, FailureEntry>();

  check(tool: string, input: unknown): ToolResult | undefined {
    const key = repeatFailureKey(tool, input);
    const previous = this.failures.get(key);
    if (!previous) return undefined;
    previous.count += 1;
    return repeatBlockedResult(tool, previous.category, key, previous.count);
  }

  record(tool: string, input: unknown, failure: ToolResult): ToolResult {
    const info = toolFailureInfo(failure);
    if (!info || !isDeterministicToolFailureCategory(info.category)) return failure;
    const key = repeatFailureKey(tool, input);
    const previous = this.failures.get(key);
    if (previous) {
      previous.count += 1;
      return repeatBlockedResult(tool, previous.category, key, previous.count);
    }
    this.failures.set(key, { category: info.category, count: 1 });
    return withRepeatMetadata(failure, { failure_count: 1, retry_blocked: false });
  }

  reset(): void {
    this.failures.clear();
  }
}

export function isDeterministicToolFailure(result: ToolResult): boolean {
  const info = toolFailureInfo(result);
  return info !== undefined && isDeterministicToolFailureCategory(info.category);
}

export function isDeterministicToolFailureCategory(category: string): boolean {
  return category === DETERMINISTIC_TOOL_FAILURE_CATEGORIES.unknownTool
    || category === DETERMINISTIC_TOOL_FAILURE_CATEGORIES.inputValidation
    || category === DETERMINISTIC_TOOL_FAILURE_CATEGORIES.staticPermissionDenied
    || category === DETERMINISTIC_TOOL_FAILURE_CATEGORIES.planPolicyDenied
    || category.startsWith("tool.input.")
    || category.startsWith("shell.input.")
    || category === "shell.background.unmanaged";
}

export function repeatFailureKey(tool: string, input: unknown): string {
  return createHash("sha256").update(tool + ":" + stableToolInput(input)).digest("hex");
}

export function stableToolInput(input: unknown): string {
  return stableJson(input);
}

function repeatBlockedResult(tool: string, originalCategory: string, key: string, count: number): ToolResult {
  return {
    is_error: true,
    error: `Repeated deterministic failure blocked for ${tool}. Change the tool input or strategy before retrying.`,
    data: {
      failure_category: REPEAT_BLOCKED_FAILURE_CATEGORY,
      failure_fingerprint: failureFingerprint(REPEAT_BLOCKED_FAILURE_CATEGORY, key + ":" + originalCategory),
      original_failure_category: originalCategory,
      failure_count: count,
      retry_blocked: true
    }
  };
}

function withRepeatMetadata(result: ToolResult, metadata: RepeatFailureMetadata): ToolResult {
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
  return { ...result, data: { ...data, ...metadata } };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return "[" + value.map((item) => item === undefined ? "null" : stableJson(item)).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
      .join(",") + "}";
  }
  return "null";
}

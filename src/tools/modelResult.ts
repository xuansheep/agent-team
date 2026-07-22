import { discoveredToolsMetadata } from "../mcp/discovery.js";
import type { ModelContentPart, ModelMessage } from "../providers/types.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT_BYTES } from "../model/modelRegistry.js";

export type ModelToolResultLimit = {
  tokenLimit?: number;
  byteLimit?: number;
};

export function toolResultMessage(
  toolCallId: string,
  result: ToolResult,
  tool: Tool,
  context?: ToolContext,
  limit: ModelToolResultLimit = {}
): ModelMessage {
  const mapped = tool.mapToolResultToModelResult?.(result, context);
  return {
    role: "tool",
    tool_call_id: toolCallId,
    ...(result.is_error === true ? { is_error: true } : {}),
    content: modelToolResultContent(mapped ?? result, limit),
    ...(discoveredToolsMetadata(result) ? { metadata: discoveredToolsMetadata(result) } : {})
  };
}

export function modelToolResultContent(value: unknown, limit: ModelToolResultLimit = {}): string | ModelContentPart[] {
  const useTokens = limit.tokenLimit !== undefined;
  const budget = Math.max(1, Math.floor(limit.tokenLimit ?? limit.byteLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT_BYTES));
  if (typeof value === "string") return truncateModelVisibleText(value, budget, useTokens);
  if (isModelContentParts(value)) {
    let remaining = budget;
    let omittedTextItems = 0;
    const content: ModelContentPart[] = [];
    for (const part of value) {
      if (part.type !== "text") {
        content.push(part);
        continue;
      }
      if (remaining === 0) {
        omittedTextItems += 1;
        continue;
      }
      const cost = useTokens ? approximateTokens(part.text) : Buffer.byteLength(part.text, "utf8");
      if (cost <= remaining) {
        content.push(part);
        remaining -= cost;
      } else {
        content.push({ ...part, text: truncateModelVisibleText(part.text, remaining, useTokens) });
        remaining = 0;
      }
    }
    if (omittedTextItems > 0) content.push({ type: "text", text: `[omitted ${omittedTextItems} text items ...]` });
    return content;
  }
  return truncateModelVisibleText(JSON.stringify(value), budget, useTokens);
}

export function truncateModelVisibleText(value: string, budget: number, useTokens = false): string {
  const source = Buffer.from(value, "utf8");
  const maxBytes = useTokens ? budget * 4 : budget;
  if (source.byteLength <= maxBytes) return value;
  const headBudget = Math.floor(maxBytes / 2);
  const tailBudget = maxBytes - headBudget;
  const head = utf8Prefix(source, headBudget);
  const tail = utf8Suffix(source, tailBudget);
  const removedBytes = Math.max(0, source.byteLength - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
  const removed = useTokens ? Math.ceil(Math.max(0, source.byteLength - maxBytes) / 4) : [...value.slice(head.length, value.length - tail.length)].length;
  const marker = useTokens ? `…${removed} tokens truncated…` : `…${removed || removedBytes} chars truncated…`;
  return `${head}${marker}${tail}`;
}

function approximateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function utf8Prefix(source: Buffer, maxBytes: number): string {
  let end = Math.min(source.byteLength, maxBytes);
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

function utf8Suffix(source: Buffer, maxBytes: number): string {
  let start = Math.max(0, source.byteLength - maxBytes);
  while (start < source.byteLength && (source[start]! & 0xc0) === 0x80) start += 1;
  return source.subarray(start).toString("utf8");
}

function isModelContentParts(value: unknown): value is ModelContentPart[] {
  if (!Array.isArray(value)) return false;
  return value.every((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const record = part as Record<string, unknown>;
    if (record.type === "text") return typeof record.text === "string";
    if (record.type === "tool_reference") return typeof record.tool_name === "string";
    if (record.type === "image") {
      return (record.media_type === "image/png" || record.media_type === "image/jpeg" || record.media_type === "image/webp")
        && typeof record.data === "string";
    }
    return false;
  });
}

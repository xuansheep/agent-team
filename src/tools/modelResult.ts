import { discoveredToolsMetadata } from "../mcp/discovery.js";
import { DEFAULT_TOOL_OUTPUT_LIMIT_BYTES } from "../model/modelRegistry.js";
import type { ModelContentPart, ModelMessage } from "../providers/types.js";
import {
  createToolResultProjection,
  ToolResultProjectionStore,
  MAX_PROJECTED_TOOL_RESULT_BYTES,
  MAX_PROJECTED_TOOL_RESULT_TOKENS
} from "../storage/toolResultProjection.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export type ModelToolResultLimit = {
  tokenLimit?: number;
  byteLimit?: number;
  toolCallId?: string;
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
    content: modelToolResultContent(mapped ?? result, { ...limit, toolCallId }),
    ...(discoveredToolsMetadata(result) ? { metadata: discoveredToolsMetadata(result) } : {})
  };
}

export async function persistedToolResultMessage(
  toolCallId: string,
  result: ToolResult,
  tool: Tool,
  context?: ToolContext,
  limit: ModelToolResultLimit = {}
): Promise<ModelMessage> {
  const mapped = tool.mapToolResultToModelResult?.(result, context);
  const value = mapped ?? result;
  const content = context?.runDir
    ? await persistedModelToolResultContent(value, { ...context, runDir: context.runDir }, { ...limit, toolCallId })
    : modelToolResultContent(value, { ...limit, toolCallId });
  return {
    role: "tool",
    tool_call_id: toolCallId,
    ...(result.is_error === true ? { is_error: true } : {}),
    content,
    ...(discoveredToolsMetadata(result) ? { metadata: discoveredToolsMetadata(result) } : {})
  };
}

export function modelToolResultContent(value: unknown, limit: ModelToolResultLimit = {}): string | ModelContentPart[] {
  const useTokens = limit.tokenLimit !== undefined;
  const requested = Math.max(1, Math.floor(limit.tokenLimit ?? limit.byteLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT_BYTES));
  const budget = Math.min(requested, useTokens ? MAX_PROJECTED_TOOL_RESULT_TOKENS : MAX_PROJECTED_TOOL_RESULT_BYTES);
  const toolCallId = limit.toolCallId ?? "unscoped-tool-result";

  if (typeof value === "string") {
    return createToolResultProjection(toolCallId, value, {
      ...(useTokens ? { tokenLimit: budget } : { byteLimit: budget })
    }).projected_content;
  }
  if (isModelContentParts(value)) {
    let remaining = budget;
    let omittedTextItems = 0;
    let textIndex = 0;
    const content: ModelContentPart[] = [];
    for (const part of value) {
      if (part.type !== "text") {
        content.push(part);
        continue;
      }
      if (remaining === 0) {
        omittedTextItems += 1;
        textIndex += 1;
        continue;
      }
      const projected = createToolResultProjection(`${toolCallId}:text:${textIndex}`, part.text, {
        ...(useTokens ? { tokenLimit: remaining } : { byteLimit: remaining })
      }).projected_content;
      content.push({ ...part, text: projected });
      remaining = Math.max(0, remaining - (useTokens ? approximateTokens(projected) : Buffer.byteLength(projected, "utf8")));
      textIndex += 1;
    }
    if (omittedTextItems > 0 && remaining > 0) {
      const omitted = `[omitted ${omittedTextItems} text items ...]`;
      content.push({ type: "text", text: truncateModelVisibleText(omitted, remaining, useTokens) });
    }
    return content;
  }
  return createToolResultProjection(toolCallId, value, {
    ...(useTokens ? { tokenLimit: budget } : { byteLimit: budget })
  }).projected_content;
}

async function persistedModelToolResultContent(
  value: unknown,
  context: ToolContext & { runDir: string },
  limit: ModelToolResultLimit
): Promise<string | ModelContentPart[]> {
  const useTokens = limit.tokenLimit !== undefined;
  const requested = Math.max(1, Math.floor(limit.tokenLimit ?? limit.byteLimit ?? DEFAULT_TOOL_OUTPUT_LIMIT_BYTES));
  const budget = Math.min(requested, useTokens ? MAX_PROJECTED_TOOL_RESULT_TOKENS : MAX_PROJECTED_TOOL_RESULT_BYTES);
  const toolCallId = limit.toolCallId ?? "unscoped-tool-result";
  const store = new ToolResultProjectionStore(context.runDir);
  const persist = (id: string, item: unknown, remaining: number) => store.persist(id, item, {
    ...(useTokens ? { tokenLimit: remaining } : { byteLimit: remaining }),
    nodeId: context.nodeId,
    attempt: context.attempt,
    activation: context.activation
  });

  if (!isModelContentParts(value)) {
    return (await persist(toolCallId, value, budget)).projected_content;
  }

  let remaining = budget;
  let omittedTextItems = 0;
  let textIndex = 0;
  const content: ModelContentPart[] = [];
  for (const part of value) {
    if (part.type !== "text") {
      content.push(part);
      continue;
    }
    if (remaining === 0) {
      omittedTextItems += 1;
      textIndex += 1;
      continue;
    }
    const projected = (await persist(`${toolCallId}:text:${textIndex}`, part.text, remaining)).projected_content;
    content.push({ ...part, text: projected });
    remaining = Math.max(0, remaining - (useTokens ? approximateTokens(projected) : Buffer.byteLength(projected, "utf8")));
    textIndex += 1;
  }
  if (omittedTextItems > 0 && remaining > 0) {
    const omitted = `[omitted ${omittedTextItems} text items ...]`;
    content.push({ type: "text", text: truncateModelVisibleText(omitted, remaining, useTokens) });
  }
  return content;
}

export function truncateModelVisibleText(value: string, budget: number, useTokens = false): string {
  const cappedBudget = Math.min(
    Math.max(1, Math.floor(budget)),
    useTokens ? MAX_PROJECTED_TOOL_RESULT_TOKENS : MAX_PROJECTED_TOOL_RESULT_BYTES
  );
  const source = Buffer.from(value, "utf8");
  const maxBytes = useTokens ? cappedBudget * 4 : cappedBudget;
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

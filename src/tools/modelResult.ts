import { discoveredToolsMetadata } from "../mcp/discovery.js";
import type { ModelContentPart, ModelMessage } from "../providers/types.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export function toolResultMessage(
  toolCallId: string,
  result: ToolResult,
  tool: Tool,
  context?: ToolContext
): ModelMessage {
  const mapped = tool.mapToolResultToModelResult?.(result, context);
  return {
    role: "tool",
    tool_call_id: toolCallId,
    ...(result.is_error === true ? { is_error: true } : {}),
    content: modelToolResultContent(mapped ?? result),
    ...(discoveredToolsMetadata(result) ? { metadata: discoveredToolsMetadata(result) } : {})
  };
}

export function modelToolResultContent(value: unknown): string | ModelContentPart[] {
  if (typeof value === "string") return value;
  if (isModelContentParts(value)) return value;
  return JSON.stringify(value);
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

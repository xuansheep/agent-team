import type { ModelUsage } from "./usage.js";
import type { ModelMessage } from "../providers/types.js";

const BYTES_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 2_000;

export function contextTokensFromUsage(usage: ModelUsage | undefined): number | undefined {
  if (usage?.totalTokens !== undefined) return Math.max(0, usage.totalTokens);
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  return Math.max(0, usage.inputTokens ?? 0) + Math.max(0, usage.outputTokens ?? 0);
}

export function estimateModelMessageTokens(message: ModelMessage): number {
  let bytes = 0;
  let fixedTokens = 0;

  if (typeof message.content === "string") {
    bytes += Buffer.byteLength(message.content, "utf8");
  } else {
    for (const part of message.content) {
      if (part.type === "text") bytes += Buffer.byteLength(part.text, "utf8");
      else fixedTokens += IMAGE_TOKEN_ESTIMATE;
    }
  }

  for (const call of message.tool_calls ?? []) {
    bytes += Buffer.byteLength(call.name, "utf8");
    bytes += Buffer.byteLength(JSON.stringify(call.input ?? {}) ?? "{}", "utf8");
  }

  return fixedTokens + Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function estimateModelMessagesTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateModelMessageTokens(message), 0);
}

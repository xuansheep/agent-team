import type { ModelUsage } from "./usage.js";
import type { ModelMessage } from "../providers/types.js";

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 2_000;

export function contextTokensFromUsage(usage: ModelUsage | undefined): number | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  return Math.max(0, usage.inputTokens ?? 0) + Math.max(0, usage.outputTokens ?? 0);
}

export function estimateModelMessageTokens(message: ModelMessage): number {
  let characters = 0;
  let fixedTokens = 0;

  if (typeof message.content === "string") {
    characters += message.content.length;
  } else {
    for (const part of message.content) {
      if (part.type === "text") characters += part.text.length;
      else fixedTokens += IMAGE_TOKEN_ESTIMATE;
    }
  }

  for (const call of message.tool_calls ?? []) {
    characters += call.name.length;
    characters += (JSON.stringify(call.input ?? {}) ?? "{}").length;
  }

  return fixedTokens + Math.round(characters / CHARS_PER_TOKEN);
}

export function estimateModelMessagesTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateModelMessageTokens(message), 0);
}

import { ModelMessage } from "../providers/types.js";

export function compactMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= 20) return messages;
  const first = messages[0];
  const recent = messages.slice(-19);
  return [first, ...recent];
}

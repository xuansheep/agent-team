import { estimateModelMessageTokens } from "./contextUsage.js";
import { ModelProviderError, type ModelMessage } from "../providers/types.js";
import { isHumanUserMessage } from "../context/messages.js";

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export function compactSummaryPrompt(): string {
  return `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Authority rules:
- Preserve the exact priority of user requirements and canonical handoffs.
- Latest user input and top-level handoff override conflicting older artifacts or previous_handoff content.
- Never reinterpret a later requirement as speculation merely because an older artifact conflicts with it.
- Treat this summary as non-authoritative; record conflicts instead of resolving them by changing requirements.

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
}

export function compactSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: `${SUMMARY_PREFIX}\n${formatCompactSummary(summary)}`,
    metadata: { compactSummary: true, userMessageKind: "compaction" }
  };
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) formatted = summaryMatch[1]?.trim() ?? "";
  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

export function isDurableRuntimeContext(message: ModelMessage): boolean {
  if (message.role !== "user" || message.metadata?.userMessageKind !== "runtime_context") return false;
  if (message.metadata.durableRuntimeContext === true) return true;
  if (typeof message.content !== "string") return false;
  try {
    const parsed = JSON.parse(message.content) as { type?: unknown };
    return parsed.type === "node_transition_result";
  } catch {
    return false;
  }
}

export function buildCompactedDialogue(
  messages: readonly ModelMessage[],
  summaryMessage: ModelMessage,
  tokenBudget = COMPACT_USER_MESSAGE_MAX_TOKENS
): ModelMessage[] {
  let remaining = Math.max(0, Math.floor(tokenBudget));
  const retained: ModelMessage[] = [];
  let latestDurableIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isDurableRuntimeContext(messages[index]!)) {
      latestDurableIndex = index;
      break;
    }
  }
  const candidates = messages.filter((message, index) =>
    isHumanUserMessage(message) || index === latestDurableIndex
  );
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = candidates[index]!;
    const tokens = estimateModelMessageTokens(message);
    if (tokens <= remaining) {
      retained.unshift(message);
      remaining -= tokens;
      continue;
    }
    const truncated = truncateUserMessageToTokens(message, remaining);
    if (truncated) retained.unshift({
      ...truncated,
      ...(isDurableRuntimeContext(message)
        ? { metadata: { ...truncated.metadata, durableRuntimeContext: true } }
        : {})
    });
    break;
  }
  return [...retained, summaryMessage];
}

export function dropOldestCompactionItem(messages: readonly ModelMessage[]): ModelMessage[] | undefined {
  if (!messages.length) return undefined;
  const drop = new Set<number>([0]);
  const first = messages[0]!;
  if (first.role === "assistant" && first.tool_calls?.length) {
    const ids = new Set(first.tool_calls.map((call) => call.id));
    for (let index = 1; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role === "tool" && message.tool_call_id && ids.has(message.tool_call_id)) drop.add(index);
      else if (message.role === "user" || message.role === "assistant") break;
    }
  } else if (first.role === "tool" && first.tool_call_id) {
    const paired = messages.findIndex((message) =>
      message.role === "assistant" && message.tool_calls?.some((call) => call.id === first.tool_call_id)
    );
    if (paired >= 0) drop.add(paired);
  }
  const remaining = messages.filter((_, index) => !drop.has(index));
  return remaining.length < messages.length ? remaining : undefined;
}

export function isContextLimitError(error: unknown): boolean {
  return error instanceof ModelProviderError && error.errorKind === "context_limit";
}

function truncateUserMessageToTokens(message: ModelMessage, tokenBudget: number): ModelMessage | undefined {
  if (tokenBudget <= 0) return undefined;
  if (typeof message.content === "string") {
    const content = truncateMiddleTokens(message.content, tokenBudget);
    return content ? { ...message, content } : undefined;
  }
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.type === "text" ? part.text : "")
    .join("\n");
  const content = truncateMiddleTokens(text, tokenBudget);
  return content ? { ...message, content } : undefined;
}

function truncateMiddleTokens(value: string, tokenBudget: number): string {
  const source = Buffer.from(value, "utf8");
  const maxBytes = tokenBudget * 4;
  if (source.byteLength <= maxBytes) return value;
  const leftBytes = Math.floor(maxBytes / 2);
  const rightBytes = maxBytes - leftBytes;
  let leftEnd = leftBytes;
  while (leftEnd > 0 && (source[leftEnd]! & 0xc0) === 0x80) leftEnd -= 1;
  let start = Math.max(leftEnd, source.byteLength - rightBytes);
  while (start < source.byteLength && (source[start]! & 0xc0) === 0x80) start += 1;
  const removedTokens = Math.ceil(Math.max(0, source.byteLength - maxBytes) / 4);
  return `${source.subarray(0, leftEnd).toString("utf8")}…${removedTokens} tokens truncated…${source.subarray(start).toString("utf8")}`;
}

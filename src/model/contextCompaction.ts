import { estimateModelMessageTokens } from "./contextUsage.js";
import { ModelProviderError, type ModelMessage } from "../providers/types.js";

export const MICROCOMPACT_CLEARED_MESSAGE = "[Old tool result content cleared]";
export const MICROCOMPACT_KEEP_RECENT = 5;
export const MAX_COMPACTION_PROMPT_TOO_LONG_RETRIES = 3;
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

const COMPACTABLE_TOOLS = new Set([
  "Read",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "MultiEdit",
  "Write"
]);

export type MicrocompactResult = {
  messages: ModelMessage[];
  clearedToolCallIds: string[];
  tokensFreed: number;
};

export function microcompactMessages(
  messages: readonly ModelMessage[],
  keepRecent = MICROCOMPACT_KEEP_RECENT
): MicrocompactResult {
  const compactableIds: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (COMPACTABLE_TOOLS.has(call.name)) compactableIds.push(call.id);
    }
  }

  const keepCount = Math.max(1, keepRecent);
  const keepIds = new Set(compactableIds.slice(-keepCount));
  const clearIds = new Set(compactableIds.filter((id) => !keepIds.has(id)));
  if (!clearIds.size) return { messages: [...messages], clearedToolCallIds: [], tokensFreed: 0 };

  let tokensFreed = 0;
  const clearedToolCallIds: string[] = [];
  const compacted = messages.map((message) => {
    if (
      message.role !== "tool"
      || !message.tool_call_id
      || !clearIds.has(message.tool_call_id)
      || message.content === MICROCOMPACT_CLEARED_MESSAGE
    ) {
      return message;
    }

    const replacement: ModelMessage = {
      ...message,
      content: MICROCOMPACT_CLEARED_MESSAGE
    };
    tokensFreed += Math.max(0, estimateModelMessageTokens(message) - estimateModelMessageTokens(replacement));
    clearedToolCallIds.push(message.tool_call_id);
    return replacement;
  });

  return {
    messages: compacted,
    clearedToolCallIds,
    tokensFreed
  };
}

export function compactSummaryPrompt(): string {
  return `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your task is to create a detailed summary of the conversation so far so another model turn can continue the work without losing important context.

Before the final summary, use an <analysis> block to check completeness. Then return a <summary> block with these sections:

1. Primary Request and Intent
2. Key Technical Concepts and Decisions
3. Files and Code Sections
4. Errors and Fixes
5. Problems Solved and Remaining Risks
6. All User Messages
7. Pending Tasks
8. Current Work
9. Next Step

Preserve exact file names, identifiers, commands, configuration values, error messages, user corrections, unfinished work, and safety constraints. Do not call tools. Tool calls will be rejected.`;
}

export function compactSummaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: `This node conversation is continuing after automatic context compaction. The summary below covers the earlier dialogue.

${formatCompactSummary(summary)}

Continue directly from where the work stopped. Do not acknowledge the compaction, recap the summary, or ask the user to repeat information.`,
    metadata: { compactSummary: true }
  };
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) formatted = summaryMatch[1]?.trim() ?? "";
  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

export function truncateOldestDialogueRounds(messages: readonly ModelMessage[]): ModelMessage[] | undefined {
  const groups: ModelMessage[][] = [];
  let current: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) groups.push(current);
  if (groups.length < 2) return undefined;

  const dropCount = Math.min(groups.length - 1, Math.max(1, Math.floor(groups.length * 0.2)));
  return [
    { role: "user", content: "[Earlier node dialogue truncated for compaction retry]" },
    ...groups.slice(dropCount).flat()
  ];
}

export function isContextLimitError(error: unknown): boolean {
  return error instanceof ModelProviderError && error.errorKind === "context_limit";
}

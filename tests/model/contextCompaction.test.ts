import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactedDialogue,
  compactSummaryMessage,
  compactSummaryPrompt,
  dropOldestCompactionItem,
  formatCompactSummary,
} from "../../src/model/contextCompaction.js";
import type { ModelMessage } from "../../src/providers/types.js";

describe("context compaction", () => {
  it("retains only the newest real user messages within the Codex budget", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old-" + "x".repeat(80), metadata: { userMessageKind: "human" } },
      { role: "user", content: "runtime", metadata: { userMessageKind: "runtime_context" } },
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest", metadata: { userMessageKind: "human" } }
    ];
    const summary = compactSummaryMessage("summary");
    const compacted = buildCompactedDialogue(messages, summary, 8);

    assert.equal(compacted.at(-1), summary);
    assert.equal(compacted.some((message) => message.content === "runtime"), false);
    assert.equal(compacted.some((message) => message.content === "latest"), true);
    assert.equal(compacted.filter((message) => message.metadata?.userMessageKind === "human").length, 2);
  });

  it("normalizes compact summaries and marks the replacement message", () => {
    const summary = formatCompactSummary("<analysis>internal check</analysis><summary>First\n\n\nSecond</summary>");
    const message = compactSummaryMessage(summary);

    assert.equal(summary, "First\n\nSecond");
    assert.equal(message.role, "user");
    assert.equal(message.metadata?.compactSummary, true);
    assert.equal(message.metadata?.userMessageKind, "compaction");
    assert.match(String(message.content), /First\n\nSecond/);
  });

  it("identifies the summarization request as internal control text", () => {
    assert.match(compactSummaryPrompt(), /CONTEXT CHECKPOINT COMPACTION/);
    assert.match(compactSummaryPrompt(), /Current progress and key decisions made/);
    assert.match(compactSummaryPrompt(), /seamlessly continue the work/);
  });

  it("drops the oldest item and its paired tool result for an oversized summary retry", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "a1", tool_calls: [{ id: "t1", name: "Read", input: {} }] },
      { role: "tool", tool_call_id: "t1", content: "r1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" }
    ];

    const truncated = dropOldestCompactionItem(messages);

    assert.equal(truncated?.some((message) => message.content === "a1"), false);
    assert.equal(truncated?.some((message) => message.content === "r1"), false);
    assert.equal(truncated?.some((message) => message.content === "a2"), true);
  });
});

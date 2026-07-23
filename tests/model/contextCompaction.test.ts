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

  it("retains only the newest durable transition and keeps the summary last", () => {
    const oldTransition = JSON.stringify({ type: "node_transition_result", handoff: { instruction: "实现4卡" } });
    const latestTransition = JSON.stringify({ type: "node_transition_result", handoff: { instruction: "实现8卡" } });
    const messages: ModelMessage[] = [
      { role: "user", content: oldTransition, metadata: { userMessageKind: "runtime_context", durableRuntimeContext: true } },
      { role: "user", content: "ordinary runtime", metadata: { userMessageKind: "runtime_context" } },
      { role: "user", content: "latest requirement", metadata: { userMessageKind: "human" } },
      { role: "user", content: latestTransition, metadata: { userMessageKind: "runtime_context" } }
    ];
    const summary = compactSummaryMessage("summary");
    const compacted = buildCompactedDialogue(messages, summary, 1_000);

    assert.equal(compacted.at(-1), summary);
    assert.equal(compacted.some((message) => message.content === oldTransition), false);
    assert.equal(compacted.some((message) => message.content === "ordinary runtime"), false);
    assert.equal(compacted.some((message) => message.content === "latest requirement"), true);
    assert.equal(compacted.some((message) => message.content === latestTransition), true);
  });

  it("recognizes legacy transition payloads as durable without metadata", () => {
    const transition = JSON.stringify({ type: "node_transition_result", handoff: { instruction: "current" } });
    const compacted = buildCompactedDialogue([
      { role: "user", content: transition, metadata: { userMessageKind: "runtime_context" } }
    ], compactSummaryMessage("summary"), 1_000);

    assert.equal(compacted.some((message) => message.content === transition), true);
    assert.equal(compacted[0]?.metadata?.durableRuntimeContext, undefined);
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
    assert.match(compactSummaryPrompt(), /Latest user input and top-level handoff override/);
    assert.match(compactSummaryPrompt(), /summary as non-authoritative/);
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

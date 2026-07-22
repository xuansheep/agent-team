import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactSummaryMessage,
  formatCompactSummary,
  MICROCOMPACT_CLEARED_MESSAGE,
  microcompactMessages,
  truncateOldestDialogueRounds
} from "../../src/model/contextCompaction.js";
import type { ModelMessage } from "../../src/providers/types.js";

describe("context compaction", () => {
  it("microcompacts old tool results while preserving the five most recent compactable results", () => {
    const messages: ModelMessage[] = [];
    for (let index = 1; index <= 7; index += 1) {
      messages.push({
        role: "assistant",
        content: `reading ${index}`,
        tool_calls: [{ id: `read-${index}`, name: "Read", input: { path: `file-${index}.ts` } }]
      });
      messages.push({ role: "tool", tool_call_id: `read-${index}`, content: `result-${index}-${"x".repeat(80)}` });
    }
    messages.push({
      role: "assistant",
      content: "custom",
      tool_calls: [{ id: "custom-1", name: "CustomTool", input: {} }]
    });
    messages.push({ role: "tool", tool_call_id: "custom-1", content: "custom-result" });

    const compacted = microcompactMessages(messages);

    assert.deepEqual(compacted.clearedToolCallIds, ["read-1", "read-2"]);
    assert.ok(compacted.tokensFreed > 0);
    assert.equal(compacted.messages.find((message) => message.tool_call_id === "read-1")?.content, MICROCOMPACT_CLEARED_MESSAGE);
    assert.equal(compacted.messages.find((message) => message.tool_call_id === "read-2")?.content, MICROCOMPACT_CLEARED_MESSAGE);
    assert.match(String(compacted.messages.find((message) => message.tool_call_id === "read-3")?.content), /result-3/);
    assert.equal(compacted.messages.find((message) => message.tool_call_id === "custom-1")?.content, "custom-result");
    assert.match(String(messages.find((message) => message.tool_call_id === "read-1")?.content), /result-1/);
  });

  it("normalizes compact summaries and marks the replacement message", () => {
    const summary = formatCompactSummary("<analysis>internal check</analysis><summary>First\n\n\nSecond</summary>");
    const message = compactSummaryMessage(summary);

    assert.equal(summary, "First\n\nSecond");
    assert.equal(message.role, "user");
    assert.equal(message.metadata?.compactSummary, true);
    assert.match(String(message.content), /First\n\nSecond/);
  });

  it("drops the oldest complete dialogue rounds for an oversized summary retry", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "tool", tool_call_id: "t1", content: "r1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" }
    ];

    const truncated = truncateOldestDialogueRounds(messages);

    assert.equal(truncated?.[0]?.role, "user");
    assert.match(String(truncated?.[0]?.content), /truncated/);
    assert.equal(truncated?.some((message) => message.content === "u1"), false);
    assert.equal(truncated?.some((message) => message.content === "a2"), true);
  });
});

import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";

const transcriptHint = "ctrl + t to view transcript";

describe("RunLogPanel compact tool output", () => {
  it("keeps the transcript hint visible for long completed tool output", () => {
    const longLine = "x".repeat(260);
    const detailText = [
      `输出：${longLine}`,
      longLine,
      `… +8 lines (${transcriptHint})`,
      "tail-line-1",
      "tail-line-2",
      "退出码：0"
    ].join("\n");

    const output = render(
      <RunLogPanel
        detailMode={false}
        currentNodeId="product"
        currentAttempt={1}
        items={[{
          id: "tool-1",
          kind: "tool",
          nodeId: "product",
          attempt: 1,
          toolCallId: "tool-1",
          tool: "Bash",
          status: "completed",
          text: "Bash",
          summary: "npm test",
          detailText
        }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Ran npm test/);
    assert.match(frame, /ctrl \+ t to view transcript/);
    assert.match(frame, /tail-line-2/);
    output.unmount();
    output.cleanup();
  });

  it("renders assistant preamble with completed non-shell tools as Codex-style transcript entries", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        currentNodeId="product"
        currentAttempt={1}
        items={[
          { id: "assistant-1", kind: "assistant", nodeId: "product", attempt: 1, text: "我先检查项目结构，再确认关键配置。" },
          {
            id: "tool-1",
            kind: "tool",
            nodeId: "product",
            attempt: 1,
            parentLogId: "assistant-1",
            toolCallId: "tool-1",
            tool: "LS",
            status: "completed",
            text: "List",
            summary: ".",
            detailText: "输出：package.json\nsrc\n退出码：0"
          }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /● 我先检查项目结构，再确认关键配置。/);
    assert.match(frame, /⎿\s+Ran List \./);
    assert.match(frame, /输出：package\.json/);
    assert.doesNotMatch(frame, /List \(\.\)/);
    output.unmount();
    output.cleanup();
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";

const transcriptHint = "ctrl + o to view transcript";

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
    assert.match(frame, /ctrl \+ o to view transcript/);
    assert.doesNotMatch(frame, /tail-line-2/);
    output.unmount();
    output.cleanup();
  });

  it("folds completed non-shell tool output in compact mode", () => {
    const compact = render(
      <RunLogPanel
        detailMode={false}
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

    const frame = compact.lastFrame() ?? "";
    assert.match(frame, /● 我先检查项目结构，再确认关键配置。/);
    assert.match(frame, /⎿\s+Ran List \./);
    assert.doesNotMatch(frame, /输出：package\.json/);
    assert.doesNotMatch(frame, /List \(\.\)/);
    compact.unmount();
    compact.cleanup();
  });

  it("shows completed tool output in transcript mode", () => {
    const transcript = render(
      <RunLogPanel
        detailMode
        items={[{
          id: "tool-1",
          kind: "tool",
          nodeId: "product",
          attempt: 1,
          toolCallId: "tool-1",
          tool: "LS",
          status: "completed",
          text: "List",
          summary: ".",
          detailText: "输出：package.json\nsrc\n退出码：0"
        }]}
      />
    );

    const frame = transcript.lastFrame() ?? "";
    assert.match(frame, /Ran List \./);
    assert.match(frame, /输出：package\.json/);
    assert.match(frame, /退出码：0/);
    transcript.unmount();
    transcript.cleanup();
  });
  it("renders complete plan documents in compact mode", () => {
    const longPlan = [
      ...Array.from({ length: 90 }, (_, index) => `Step ${String(index + 1).padStart(2, "0")}: keep the complete approval plan visible.`),
      "TAIL_SENTINEL_AFTER_2400_CHARS"
    ].join("\n");
    const output = render(
      <RunLogPanel
        detailMode={false}
        items={[{
          id: "plan-1",
          kind: "plan",
          nodeId: "global-plan",
          attempt: 1,
          status: "pending",
          text: "Plan Review",
          document: longPlan,
          path: ".session/plans/plan.md"
        }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Plan saved to: \.session\/plans\/plan\.md · \/plan to edit/);
    assert.match(frame, /TAIL_SENTINEL_AFTER_2400_CHARS/);
    output.unmount();
    output.cleanup();
  });

});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";

const transcriptHint = "ctrl + o to view transcript";

describe("RunLogPanel compact tool output", () => {
  it("strips tool-provided ANSI styles from the title and detail", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[0m";
    const output = render(
      <RunLogPanel
        detailMode
        items={[{
          id: "tool-ansi",
          kind: "tool",
          nodeId: "product",
          attempt: 1,
          toolCallId: "tool-ansi",
          tool: "Bash",
          status: "completed",
          text: "Bash",
          summary: `${red}npm test${reset}`,
          detailText: `gray ${reset}white ${red}red${reset}`
        }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Ran npm test/);
    assert.match(frame, /gray white red/);
    assert.doesNotMatch(frame, /\u001b\[31m|\u001b\[0m/);
    output.unmount();
    output.cleanup();
  });

  it("strips tool-provided ANSI styles from compact detail", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[0m";
    const output = render(
      <RunLogPanel
        detailMode={false}
        items={[{
          id: "tool-ansi-compact",
          kind: "tool",
          nodeId: "product",
          attempt: 1,
          toolCallId: "tool-ansi-compact",
          tool: "Bash",
          status: "completed",
          text: "Bash",
          summary: "npm test",
          detailText: "unused",
          compactDetailText: `output: gray ${reset}white ${red}red${reset}`
        }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /output: gray white red/);
    assert.doesNotMatch(frame, /\u001b\[31m|\u001b\[0m/);
    output.unmount();
    output.cleanup();
  });

  it("renders system status logs with deep-gray dots", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        items={[{ id: "status-1", kind: "status", text: "Plan Mode restored", detailText: "hidden detail" }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Plan Mode restored/);
    assert.match(frame, /• Plan Mode restored/);
    assert.doesNotMatch(frame, /hidden detail/);
    output.unmount();
    output.cleanup();
  });

  it("keeps the transcript hint visible for long completed tool output", () => {
    const longLine = "x".repeat(260);
    const compactDetailText = [
      longLine,
      longLine,
      `… +8 lines (${transcriptHint})`,
      "tail-line-1",
      "tail-line-2",
    ].join("\n");
    const detailText = [
      longLine,
      longLine,
      "middle-line",
      "tail-line-1",
      "tail-line-2",
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
          detailText,
          compactDetailText
        }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Ran npm test/);
    assert.match(frame, /ctrl \+ o to view transcript/);
    assert.doesNotMatch(frame, /middle-line/);
    assert.match(frame, /tail-line-2/);
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
            detailText: "package.json\nsrc"
          }
        ]}
      />
    );

    const frame = compact.lastFrame() ?? "";
    assert.match(frame, /• 我先检查项目结构，再确认关键配置。/);
    assert.match(frame, /• Explored/);
    assert.match(frame, /└ List \./);
    assert.doesNotMatch(frame, /└\s+Ran List/);
    assert.doesNotMatch(frame, /package\.json/);
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
          detailText: "package.json\nsrc"
        }]}
      />
    );

    const frame = transcript.lastFrame() ?? "";
    assert.match(frame, /Ran List \./);
    assert.match(frame, /└ package\.json/);
    assert.doesNotMatch(frame, /Exit code:/);
    transcript.unmount();
    transcript.cleanup();
  });

  it("shows untruncated completed tool output in transcript mode", () => {
    const detailText = `${"x".repeat(6500)}\nFULL_DETAIL_SENTINEL_AFTER_6500_CHARS`;
    const transcript = render(
      <RunLogPanel
        detailMode
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
          detailText,
          compactDetailText: `xx\n… +10 lines (${transcriptHint})`
        }]}
      />
    );

    const frame = transcript.lastFrame() ?? "";
    assert.match(frame, /Ran npm test/);
    assert.match(frame, /FULL_DETAIL_SENTINEL_AFTER_6500_CHARS/);
    assert.doesNotMatch(frame, /ctrl \+ o to view transcript/);
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

  it("separates repeated assistant messages in one execution chain and resets after user input", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        columns={24}
        items={[
          { id: "assistant-1", kind: "assistant", nodeId: "developer", attempt: 1, activation: 1, text: "First assistant message" },
          { id: "tool-1", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, parentLogId: "assistant-1", toolCallId: "tool-1", tool: "LS", status: "completed", text: "List", summary: ".", detailText: "" },
          { id: "assistant-2", kind: "assistant", nodeId: "developer", attempt: 1, activation: 1, text: "Second assistant message" },
          { id: "user-1", kind: "user", text: "Continue" },
          { id: "assistant-3", kind: "assistant", nodeId: "developer", attempt: 1, activation: 1, text: "After user message" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    const dividerLines = frame.split("\n").filter((line) => /^─+$/.test(line));
    assert.equal(dividerLines.length, 1);
    assert.equal(dividerLines[0]?.length, 24);
    const dividerIndex = frame.indexOf(dividerLines[0] ?? "");
    const secondAssistantIndex = frame.indexOf("• Second assistant message");
    assert.ok(frame.indexOf("List .") < dividerIndex);
    assert.match(frame, /List \.\n\n─+/);
    assert.equal(frame.slice(dividerIndex, secondAssistantIndex), `${dividerLines[0]}\n\n`);
    assert.ok(dividerIndex < secondAssistantIndex);
    assert.ok(frame.indexOf("Continue") < frame.indexOf("After user message"));
    output.unmount();
    output.cleanup();
  });


  it("groups consecutive local exploration tools and keeps one blank row between blocks", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        items={[
          { id: "assistant-1", kind: "assistant", nodeId: "developer", attempt: 1, activation: 1, text: "Inspecting." },
          { id: "list-1", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "list-1", tool: "LS", status: "completed", text: "List", summary: ".", detailText: "src" },
          { id: "read-1", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "read-1", tool: "Read", status: "completed", text: "Read", summary: "src/index.ts", detailText: "contents" },
          { id: "status-1", kind: "status", nodeId: "developer", attempt: 1, activation: 1, text: "Ready" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /^\n• Inspecting\.\n\n• Explored\n  └ List \.\n    Read src\/index\.ts\n\n• Ready$/);
    assert.doesNotMatch(frame, /●|Ran List|Ran Read/);
    output.unmount();
    output.cleanup();
  });

  it("keeps exploration tools ungrouped with full output in transcript mode", () => {
    const output = render(
      <RunLogPanel
        detailMode
        items={[
          { id: "list-1", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "list-1", tool: "LS", status: "completed", text: "List", summary: ".", detailText: "src" },
          { id: "read-1", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "read-1", tool: "Read", status: "completed", text: "Read", summary: "src/index.ts", detailText: "contents" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /• Ran List \.\n  └ src\n\n• Ran Read src\/index\.ts\n  └ contents/);
    assert.doesNotMatch(frame, /Explored/);
    output.unmount();
    output.cleanup();
  });

  it("maps supported local read-only tools into exploration entries and stops at mutations", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        items={[
          { id: "glob", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "glob", tool: "Glob", status: "completed", text: "Glob", summary: "**/*.ts", detailText: "" },
          { id: "grep", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "grep", tool: "Grep", status: "completed", text: "Grep", summary: "TODO", detailText: "" },
          { id: "artifact", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "artifact", tool: "ArtifactRead", status: "completed", text: "ArtifactRead", summary: "spec.md", detailText: "" },
          { id: "bash-read", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "bash-read", tool: "Bash", status: "completed", text: "Bash", summary: "git status", detailText: "" },
          { id: "powershell-read", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "powershell-read", tool: "PowerShell", status: "completed", text: "PowerShell", summary: "Get-ChildItem", detailText: "" },
          { id: "bash-write", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "bash-write", tool: "Bash", status: "completed", text: "Bash", summary: "npm test", detailText: "" },
          { id: "read-after", kind: "tool", nodeId: "developer", attempt: 1, activation: 1, toolCallId: "read-after", tool: "Read", status: "completed", text: "Read", summary: "README.md", detailText: "" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /└ List \*\*\/\*\.ts/);
    assert.match(frame, /Search TODO/);
    assert.match(frame, /Read spec\.md/);
    assert.match(frame, /Run git status/);
    assert.match(frame, /Run Get-ChildItem/);
    assert.match(frame, /• Ran npm test/);
    assert.equal((frame.match(/• Explored/g) ?? []).length, 2);
    output.unmount();
    output.cleanup();
  });

  it("prefixes wrapped tool-title continuation lines with a vertical guide", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        columns={24}
        items={[
          { id: "tool", kind: "tool", nodeId: "developer", attempt: 1, toolCallId: "tool", tool: "Bash", status: "running", text: "Bash", summary: "npm run a-very-long-script-name", detailText: "" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /• Running npm run/);
    assert.match(frame, /  │ a-very-long-script-n/);
    output.unmount();
    output.cleanup();
  });


});

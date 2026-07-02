import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { ToolCallList } from "../../src/tui/components/ToolCallList.js";

describe("ToolCallList", () => {
  it("renders expanded tool details without raw JSON", () => {
    const output = render(
      <ToolCallList
        tools={[{
          nodeId: "dev",
          attempt: 1,
          toolCallId: "tool-1",
          tool: "Bash",
          status: "completed",
          input: { command: "npm test" },
          result: { output: "ok", exit_code: 0 },
          expanded: true
        }]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Bash completed/);
    assert.match(frame, /输出：ok/);
    assert.match(frame, /退出码：0/);
    assert.doesNotMatch(frame, /\{"output"/);
    output.unmount();
    output.cleanup();
  });
});

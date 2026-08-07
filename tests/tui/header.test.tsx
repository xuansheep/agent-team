import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Header } from "../../src/tui/components/Header.js";

describe("Header", () => {
  it("shows the session identifier above the workflow flow chart", () => {
    const output = render(<Header workflowId="delivery" sessionId="session-123" />);
    const frame = output.lastFrame() ?? "";

    assert.equal(frame, "workflow delivery | session session-123");
    assert.doesNotMatch(frame, /agent-team/);
    assert.doesNotMatch(frame, /CodeAI/);
    assert.doesNotMatch(frame, /\| run /);
    output.unmount();
    output.cleanup();
  });

  it("keeps the unselected workflow row in initialization errors", () => {
    const output = render(<Header />);
    assert.equal(output.lastFrame(), "workflow unselected");
    output.unmount();
    output.cleanup();
  });
});

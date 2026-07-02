import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { ModelStreamPanel } from "../../src/tui/components/ModelStreamPanel.js";

describe("ModelStreamPanel", () => {
  it("renders only visible assistant text and hides NodeResult JSON", () => {
    const output = render(
      <ModelStreamPanel
        streams={[
          { nodeId: "product", attempt: 1, text: "我先检查项目结构。\n{\"status\":\"success\",\"summary\":\"done\"}" },
          { nodeId: "dev", attempt: 1, text: "{\"status\":\"success\",\"summary\":\"done\"}" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /● 我先检查项目结构。/);
    assert.doesNotMatch(frame, /\{\"status\"/);
    assert.doesNotMatch(frame, /streaming/);
    output.unmount();
    output.cleanup();
  });
});

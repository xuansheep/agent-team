import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";
import { TuiApp } from "../../src/tui/TuiApp.js";

describe("PromptInput component", () => {
  it("renders mode and footer status", () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    assert.match(output.lastFrame() ?? "", /INPUT/);
    assert.match(output.lastFrame() ?? "", /delivery/);
    output.unmount();
    output.cleanup();
  });
});

describe("TuiApp", () => {
  it("renders missing config guidance", () => {
    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" initialError="Missing agent-team.yaml" />);

    assert.match(output.lastFrame() ?? "", /Missing agent-team.yaml/);
    assert.match(output.lastFrame() ?? "", /agent-team init/);
    output.unmount();
    output.cleanup();
  });
});

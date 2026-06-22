import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";

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

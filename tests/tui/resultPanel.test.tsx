import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { ResultPanel } from "../../src/tui/components/ResultPanel.js";

describe("ResultPanel", () => {
  it("does not render terminal run state outside the transcript", () => {
    const output = render(<ResultPanel mode="failed" error="Run failed" runId="run-1" />);

    assert.equal(output.lastFrame() ?? "", "");
    output.unmount();
    output.cleanup();
  });
});

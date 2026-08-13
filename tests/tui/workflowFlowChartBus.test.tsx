import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { WorkflowFlowChart } from "../../src/tui/components/WorkflowFlowChart.js";
import { Box } from "../../src/tui/ink.js";

const workflowNodes = [
  { id: "product", role: "product", model: "gpt-5.5", effort: "high" },
  { id: "dev", role: "developer", model: "claude-dev", effort: "low" },
  { id: "test", role: "tester", model: "gpt-test" }
];

describe("WorkflowFlowChart bus", () => {
  it("renders the bus branch above the selected workflow node", () => {
    const output = render(<WorkflowFlowChart workflowNodes={workflowNodes} nodes={[]} busNodeId="dev" />);
    const lines = (output.lastFrame() ?? "").split("\n");
    const busLine = lines.find((line) => line.startsWith("bus "));
    const cardTopLine = lines.find((line) => line.includes("┌"));

    assert.ok(busLine);
    assert.ok(cardTopLine);
    assert.match(busLine, /^bus ─+┐\s*$/);
    const firstCardStart = cardTopLine.indexOf("┌");
    const targetCardStart = cardTopLine.indexOf("┌", firstCardStart + 1);
    const targetCardEnd = cardTopLine.indexOf("┐", targetCardStart);
    assert.equal(busLine.indexOf("┐"), targetCardStart + Math.floor((targetCardEnd - targetCardStart + 1) / 2));

    output.unmount();
    output.cleanup();
  });

  it("renders an unconnected bus row before a valid scheduling decision", () => {
    for (const busNodeId of [undefined, "missing"]) {
      const output = render(<WorkflowFlowChart workflowNodes={workflowNodes} nodes={[]} busNodeId={busNodeId} />);
      const busLine = (output.lastFrame() ?? "").split("\n").find((line) => line.startsWith("bus"));
      assert.ok(busLine);
      assert.doesNotMatch(busLine, /[─┐]/);
      output.unmount();
      output.cleanup();
    }
  });

  it("keeps the branch attached to the selected card after terminal wrapping", () => {
    const output = render(
      <Box width={40}>
        <WorkflowFlowChart workflowNodes={workflowNodes} nodes={[]} busNodeId="dev" columns={40} />
      </Box>
    );
    const frame = output.lastFrame() ?? "";

    assert.match(frame, /^bus ─+/);
    assert.match(frame, /\n─+┐\n┌─+┐\n│ dev/);
    assert.doesNotMatch(frame, /\n\n┌─+┐\n│ test/);

    output.unmount();
    output.cleanup();
  });
});

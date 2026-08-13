import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { WorkflowFlowChart } from "../../src/tui/components/WorkflowFlowChart.js";
import type { AgentTeamConfig } from "../../src/config/schema.js";

const config: AgentTeamConfig = {
  providers: {
    default: {
      type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true },
      base_url: "https://api.example.test/v1",
      api_key: "test-key",
      default_model: "gpt-test",
      capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
    }
  },
  dispatcher: {
    provider: "default",
    model: "gpt-test",
    effort: "medium",
    confidence_threshold: 0.8
  },
  roles: {
    a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } },
    b: { description: "", system_prompt: "B", requires: { tool_calling: false, vision: false } }
  },
  workflows: {
    shared: {
      description: "Sequential workflow",
      nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }],
      edges: []
    }
  },
  teams: {
    shared: {
      description: "Dynamic team",
      nodes: [
        { id: "a", role: "a", provider: "default", permission_mode: "default" },
        { id: "b", role: "b", provider: "default", permission_mode: "default" }
      ],
      edges: []
    }
  }
};

describe("team TUI", () => {
  it("shows workflow and team choices at the same level, including disabled create team", () => {
    const output = render(
      <TuiApp
        cwd={process.cwd()}
        config={config}
        workflows={["shared"]}
        teams={["shared"]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Select workflow or team/);
    assert.match(frame, /shared \[workflow\]/);
    assert.match(frame, /shared \[team\]/);
    assert.match(frame, /Create new workflow/);
    assert.match(frame, /Create new team/);

    output.unmount();
    output.cleanup();
  });

  it("renders a selected team with a team header and no node arrows", () => {
    const output = render(
      <TuiApp
        cwd={process.cwd()}
        config={config}
        workflows={["shared"]}
        teams={["shared"]}
        workflowId="shared"
        executionKind="team"
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /team shared/);
    assert.match(frame, /a/);
    assert.match(frame, /b/);
    assert.doesNotMatch(frame, / -> /);

    output.unmount();
    output.cleanup();
  });

  it("keeps team nodes visible without node-to-node arrows", () => {
    const output = render(
      <WorkflowFlowChart
        workflowNodes={[
          { id: "a", role: "a", model: "gpt-test" },
          { id: "b", role: "b", model: "gpt-test" }
        ]}
        nodes={[]}
        columns={120}
        showConnectors={false}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /a/);
    assert.match(frame, /b/);
    assert.doesNotMatch(frame, / -> /);

    output.unmount();
    output.cleanup();
  });
});

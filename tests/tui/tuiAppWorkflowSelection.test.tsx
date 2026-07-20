import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import { TuiApp } from "../../src/tui/TuiApp.js";

describe("TUI workflow selection guide", () => {
  it("previews workflows in list order and enters the conversation after confirmation", async () => {
    const output = render(
      <TuiApp
        cwd="D:\\CodeAI\\agent-team"
        config={workflowConfig()}
        workflows={["alpha", "delivery"]}
      />
    );

    await settle();
    const initialFrame = output.lastFrame() ?? "";
    assert.match(initialFrame, /alpha-node/);
    assert.doesNotMatch(initialFrame, /delivery-node/);
    assert.match(initialFrame, /Delivery path/);
    assert.match(initialFrame, /Create new workflow/);
    assert.match(initialFrame, /Coming soon/);
    assert.doesNotMatch(initialFrame, /No description/);
    assert.doesNotMatch(initialFrame, /bottom interaction area/);

    output.stdin.write("\u001b[B");
    await settle();
    const deliveryPreview = output.lastFrame() ?? "";
    assert.match(deliveryPreview, /delivery-node/);
    assert.doesNotMatch(deliveryPreview, /alpha-node/);

    output.stdin.write("\r");
    await settle();
    const conversationFrame = output.lastFrame() ?? "";
    assert.match(conversationFrame, /workflow delivery/);
    assert.doesNotMatch(conversationFrame, /Select workflow/);
    assert.doesNotMatch(conversationFrame, /Create new workflow/);

    output.unmount();
  });

  it("keeps the create workflow placeholder disabled and preserves the last valid preview", async () => {
    const output = render(
      <TuiApp
        cwd="D:\\CodeAI\\agent-team"
        config={workflowConfig()}
        workflows={["alpha", "delivery"]}
      />
    );

    await settle();
    output.stdin.write("\u001b[B");
    await settle();
    output.stdin.write("\u001b[B");
    await settle();

    const placeholderFrame = output.lastFrame() ?? "";
    assert.match(placeholderFrame, /Create new workflow/);
    assert.match(placeholderFrame, /delivery-node/);

    output.stdin.write("\r");
    await settle();
    const afterEnter = output.lastFrame() ?? "";
    assert.match(afterEnter, /Select workflow/);
    assert.match(afterEnter, /workflow unselected/);
    assert.match(afterEnter, /delivery-node/);

    output.unmount();
  });
});

function workflowConfig(): AgentTeamConfig {
  return {
    providers: {
      default: {
        type: "openai-compatible",
        base_url: "https://api.example.test/v1",
        api_key: "test-key",
        default_model: "gpt-test",
        capabilities: {
          tool_calling: false,
          vision: false,
          streaming: false,
          json_schema_output: true
        }
      }
    },
    roles: {
      dev: {
        description: "",
        system_prompt: "dev",
        requires: { tool_calling: false, vision: false }
      }
    },
    workflows: {
      alpha: {
        nodes: [{ id: "alpha-node", role: "dev", provider: "default", permission_mode: "default" }],
        edges: []
      },
      delivery: {
        description: "Delivery path",
        nodes: [{ id: "delivery-node", role: "dev", provider: "default", permission_mode: "default" }],
        edges: []
      }
    }
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

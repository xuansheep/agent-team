import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider } from "../../src/providers/types.js";

describe("Plan Mode V2 workflow separation", () => {
  it("keeps workflow node plan review as pending_review and not permission mode", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Node Plan", handoff: { instruction: "implement" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/phase4-node-plan-${Date.now()}` });

    const state = await engine.run(config(), "flow", { request: "x" });

    assert.equal(state.status, "pending");
    assert.equal(state.pending_review?.node_id, "product");
    assert.equal(state.current_node_id, "product");
    assert.equal(calls, 1);
  });
});

function config() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: {
      product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const, mode: "plan" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }
  };
}

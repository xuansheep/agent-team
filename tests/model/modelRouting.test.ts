import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModelContextWindow, resolveModelAlias } from "../../src/model/modelRegistry.js";
import { resolveModelForWorkflowNode } from "../../src/model/modelRouting.js";

describe("model routing", () => {
  it("keeps workflow node model ahead of role and provider defaults", () => {
    const model = resolveModelForWorkflowNode({
      node: { model: "node-model" },
      role: { default_model: "role-model" },
      provider: { default_model: "provider-model" }
    });

    assert.equal(model, "node-model");
  });

  it("falls back from role default model to provider default model", () => {
    assert.equal(resolveModelForWorkflowNode({ role: { default_model: "role-model" }, provider: { default_model: "provider-model" } }), "role-model");
    assert.equal(resolveModelForWorkflowNode({ role: {}, provider: { default_model: "provider-model" } }), "provider-model");
  });

  it("uses a Plan Mode model override without changing normal routing", () => {
    const registry = { aliases: { plan: "gpt-plan", default: "gpt-default" } };

    assert.equal(resolveModelForWorkflowNode({ provider: { default_model: "default" }, permissionMode: "default", planModel: "plan", registry }), "gpt-default");
    assert.equal(resolveModelForWorkflowNode({ provider: { default_model: "default" }, permissionMode: "plan", planModel: "plan", registry }), "gpt-plan");
  });

  it("resolves aliases and context windows", () => {
    const registry = {
      aliases: { sonnet: "claude-sonnet-4-20250514" },
      contextWindows: { "claude-sonnet-4-20250514": 200000 },
      models: { "gpt-5": { aliases: ["gpt-latest"], contextWindow: 400000 } }
    };

    assert.equal(resolveModelAlias("sonnet", registry), "claude-sonnet-4-20250514");
    assert.equal(resolveModelAlias("gpt-latest", registry), "gpt-5");
    assert.equal(getModelContextWindow("sonnet", registry), 200000);
    assert.equal(getModelContextWindow("gpt-latest", registry), 400000);
  });
});

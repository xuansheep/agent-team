import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_CONTEXT_COMPRESSION, DEFAULT_MODEL_CONTEXT_WINDOW, getModelContextCompression, getModelContextWindow, resolveModelAlias } from "../../src/model/modelRegistry.js";
import { resolveEffortForWorkflowNode, resolveModelForWorkflowNode } from "../../src/model/modelRouting.js";

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

  it("resolves effort from node, provider, then the medium default", () => {
    assert.equal(resolveEffortForWorkflowNode({
      node: { effort: "node-custom" },
      provider: { default_model: "provider-model", effort: "provider-custom" }
    }), "node-custom");
    assert.equal(resolveEffortForWorkflowNode({
      provider: { default_model: "provider-model", effort: "provider-custom" }
    }), "provider-custom");
    assert.equal(resolveEffortForWorkflowNode({
      provider: { default_model: "provider-model" }
    }), "medium");
  });

  it("resolves aliases, context windows, and compression thresholds", () => {
    const registry = {
      aliases: { sonnet: "claude-sonnet-4-20250514" },
      contextWindows: { "claude-sonnet-4-20250514": 200000 },
      contextCompression: { "claude-sonnet-4-20250514": 180000 },
      models: { "gpt-5": { aliases: ["gpt-latest"], contextWindow: 400000, contextCompression: 380000 } }
    };

    assert.equal(resolveModelAlias("sonnet", registry), "claude-sonnet-4-20250514");
    assert.equal(resolveModelAlias("gpt-latest", registry), "gpt-5");
    assert.equal(getModelContextWindow("sonnet", registry), 200000);
    assert.equal(getModelContextCompression("sonnet", registry), 180000);
    assert.equal(getModelContextWindow("gpt-latest", registry), 400000);
    assert.equal(getModelContextCompression("gpt-latest", registry), 380000);
  });

  it("uses global defaults and caps compression at the model context window", () => {
    assert.equal(getModelContextWindow("unknown"), DEFAULT_MODEL_CONTEXT_WINDOW);
    assert.equal(getModelContextCompression("unknown"), DEFAULT_MODEL_CONTEXT_COMPRESSION);
    assert.equal(getModelContextCompression("small", {
      contextWindows: { small: 128000 },
      defaultContextCompression: 258000
    }), 128000);
  });
});

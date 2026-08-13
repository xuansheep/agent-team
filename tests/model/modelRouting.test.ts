import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_CONTEXT_WINDOW, getModelContextLimits, getModelContextWindow, getProviderMaxOutputTokens, resolveModelAlias } from "../../src/model/modelRegistry.js";
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

  it("derives Codex-compatible ninety-percent automatic compaction limits", () => {
    assert.equal(getModelContextWindow("unknown"), DEFAULT_MODEL_CONTEXT_WINDOW);
    assert.deepEqual(getModelContextLimits("unknown"), {
      contextWindow: 272000,
      effectiveContextWindow: 258400,
      maxOutputTokens: 8000,
      autoCompactLimit: 244800,
      autoCompactTokenLimitScope: "total",
      compactionHash: undefined,
      toolOutputTokenLimit: undefined,
      compactPrompt: undefined
    });
    assert.equal(getProviderMaxOutputTokens({ type: "responses-api", anthropic: { max_tokens: 20000 } }), 8000);
    assert.deepEqual(getModelContextLimits("unknown", {}, getProviderMaxOutputTokens({
      type: "anthropic",
      anthropic: { max_tokens: 20000 }
    })), {
      contextWindow: 272000,
      effectiveContextWindow: 258400,
      maxOutputTokens: 20000,
      autoCompactLimit: 244800,
      autoCompactTokenLimitScope: "total",
      compactionHash: undefined,
      toolOutputTokenLimit: undefined,
      compactPrompt: undefined
    });
    assert.equal(getModelContextLimits("small", {
      contextWindows: { small: 100000 },
      autoCompactTokenLimits: { small: 95000 }
    }).autoCompactLimit, 90000);
  });
});

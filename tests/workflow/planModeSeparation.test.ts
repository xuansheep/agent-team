import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../../src/config/schema.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";

describe("Plan Mode V2 workflow separation", () => {
  it("rejects workflow node plan mode", () => {
    assert.throws(() => configSchema.parse(configWithNodePlanMode()), /Invalid enum value/);
  });

  it("rejects workflow node plan permission mode", () => {
    assert.throws(() => configSchema.parse(configWithNodePlanPermissionMode()), /Invalid enum value/);
  });

  it("rejects removed workflow node permission modes", () => {
    for (const permission_mode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
      assert.throws(
        () => configSchema.parse(configWithNodePermissionMode(permission_mode)),
        /Invalid enum value/
      );
    }
  });

  it("rejects Plan Mode as a workflow run permission mode at runtime", async () => {
    const engine = new WorkflowEngine({
      cwd: process.cwd(),
      providerFactory: () => ({ async generate() { return { content: "{}" }; } })
    });
    const config = configSchema.parse(configWithNodeTaskMode());

    await assert.rejects(
      () => engine.run(config, "flow", { request: "build" }, { permissionMode: "plan" as never }),
      /Plan Mode must be approved before workflow execution starts/
    );
    await assert.rejects(
      () => engine.startInteractive(config, "flow", { request: "build" }, { permissionMode: "plan" as never }),
      /Plan Mode must be approved before workflow execution starts/
    );
  });
});

function configWithNodePlanMode() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: {
      product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const, mode: "plan" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }
  };
}

function configWithNodePlanPermissionMode() {
  return configWithNodePermissionMode("plan");
}

function configWithNodePermissionMode(permission_mode: string) {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: {
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode }], edges: [] } }
  };
}

function configWithNodeTaskMode() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: {
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
  };
}

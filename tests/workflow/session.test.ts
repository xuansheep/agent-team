import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider } from "../../src/providers/types.js";

describe("WorkflowSession", () => {
  it("streams events and resolves a completed result", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-runs" });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    const seen: string[] = [];
    for await (const event of session.events) {
      seen.push(event.type);
      if (event.type === "node_completed") break;
    }

    const result = await session.result;
    assert.equal(result.status, "completed");
    assert.equal(seen.includes("node_started"), true);
    assert.equal(seen.includes("node_completed"), true);
  });

  it("marks a running session interrupted", async () => {
    let release!: () => void;
    const provider: ModelProvider = {
      async generate() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-interrupt-runs" });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    for await (const event of session.events) {
      if (event.type === "node_started") break;
    }

    await session.interrupt();
    release();

    const result = await session.result;
    assert.equal(result.status, "interrupted");
  });
});

function config() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
  };
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider } from "../../src/providers/types.js";

class FakeProvider implements ModelProvider {
  async generate() {
    return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
  }
}

describe("WorkflowEngine", () => {
  it("runs two successful nodes in order", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: ".tmp/test-runs" });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } }, b: { description: "", system_prompt: "B", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }, { id: "b", role: "b", provider: "default", permission_mode: "default" }], edges: [{ from: "a", to: "b", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["a", "b"]);
  });

  it("returns to an upstream node on failure edge", async () => {
    let calls = 0;
    class FeedbackProvider implements ModelProvider {
      async generate() {
        calls += 1;
        if (calls === 2) {
          return { content: JSON.stringify({ status: "failure", summary: "reject", feedback: { defects: ["missing behavior"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "ok", handoff: { instruction: "next" } }) };
      }
    }

    const engine = new WorkflowEngine({ providerFactory: () => new FeedbackProvider(), cwd: process.cwd(), runRoot: ".tmp/test-runs" });
    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } },
        final: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }, { id: "final", role: "final", provider: "default", permission_mode: "default" }], edges: [{ from: "dev", to: "test", condition: "success" }, { from: "test", to: "final", condition: "success" }, { from: "test", to: "dev", condition: "failure" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.equal(result.attempts.filter((attempt) => attempt.node_id === "dev").length, 2);
  });

  it("resumes a waiting node with user input", async () => {
    let calls = 0;
    class WaitingProvider implements ModelProvider {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ status: "needs_user_input", summary: "need detail", questions: [{ id: "q1", text: "What is the target user?", required: true }] }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "accepted answer", handoff: { instruction: "continue" } }) };
      }
    }

    const runRoot = ".tmp/resume-runs";
    const engine = new WorkflowEngine({ providerFactory: () => new WaitingProvider(), cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "waiting_user");

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "operators" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "product").length, 2);
  });

  it("completes only after final_delivery node succeeds", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: ".tmp/final-runs" });
    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        user_acceptance: { description: "", system_prompt: "U", requires: { tool_calling: false, vision: false } },
        final_delivery: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "user_acceptance", role: "user_acceptance", provider: "default", permission_mode: "default" }, { id: "final_delivery", role: "final_delivery", provider: "default", permission_mode: "default" }], edges: [{ from: "dev", to: "user_acceptance", condition: "success" }, { from: "user_acceptance", to: "final_delivery", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["dev", "user_acceptance", "final_delivery"]);
  });

  it("rejects image handoff when provider has no vision capability", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: ".tmp/image-runs" });

    await assert.rejects(() => engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x", images: ["README.md"] }), /requires vision/);
  });
});

async function latestRunId(root: string): Promise<string> {
  const runs = await readdir(root);
  return runs.sort().at(-1) ?? "";
}

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

  it("pauses after a plan node and resumes directly to the next node after approval", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Plan\n\n1. Build it.", handoff: { instruction: "follow the approved plan" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "implemented", document: "# Summary\nDone.", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = ".tmp/plan-review-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = planReviewConfig();

    const waiting = await engine.run(config, "flow", { request: "x" });

    assert.equal(waiting.status, "waiting_plan_review");
    assert.equal(waiting.current_node_id, "product");
    assert.equal(waiting.attempts[0]?.status, "waiting_plan_review");
    assert.equal(calls, 1);

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "Yes, continue execution by plan" });

    assert.equal(resumed.status, "completed");
    assert.deepEqual(resumed.attempts.map((attempt) => `${attempt.node_id}:${attempt.status}`), ["product:success", "dev:success"]);
    assert.equal(calls, 2);
  });

  it("keeps a plan node paused when the user chooses to stay in the plan", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Plan\nStay here.", handoff: { instruction: "wait" } }) };
      }
    };
    const runRoot = ".tmp/plan-stay-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = planReviewConfig();

    const waiting = await engine.run(config, "flow", { request: "x" });
    const runId = await latestRunId(runRoot);
    const stillWaiting = await engine.resume(config, "flow", runId, { answer: "No, staying in the plan" });

    assert.equal(waiting.status, "waiting_plan_review");
    assert.equal(stillWaiting.status, "waiting_plan_review");
    assert.equal(stillWaiting.current_node_id, "product");
    assert.equal(calls, 1);
  });

  it("completes only after a complete node returns a summary document", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: JSON.stringify({ status: "success", summary: "dev done", handoff: { instruction: "summarize" } }) };
        return { content: JSON.stringify({ status: "success", summary: "final done", document: "# Delivery Summary\nEverything is complete.", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/final-runs" });
    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        final_delivery: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "final_delivery", role: "final_delivery", provider: "default", permission_mode: "default", mode: "complete" }], edges: [{ from: "dev", to: "final_delivery", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["dev", "final_delivery"]);
    assert.match(String(result.attempts.at(-1)?.result && (result.attempts.at(-1)?.result as { document?: string }).document), /Delivery Summary/);
  });

  it("rejects complete nodes that do not return a summary document", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: JSON.stringify({ status: "success", summary: "missing document", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/complete-missing-doc-runs" });

    await assert.rejects(() => engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { final_delivery: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "final_delivery", role: "final_delivery", provider: "default", permission_mode: "default", mode: "complete" }], edges: [] } }
    }, "flow", { request: "x" }), /complete node final_delivery must return document/);
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


function planReviewConfig() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: {
      product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const, mode: "plan" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }
  };
}

async function latestRunId(root: string): Promise<string> {
  const runs = await readdir(root);
  return runs.sort().at(-1) ?? "";
}

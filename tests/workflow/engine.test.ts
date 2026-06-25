import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
    const runRoot = ".tmp/final-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
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
    const finalResult = result.attempts.at(-1)?.result as { document?: string; deliverables?: Array<{ artifact_id: string; description: string }> };
    assert.match(String(finalResult.document), /Delivery Summary/);

    const runId = await latestRunId(runRoot);
    const artifactPath = join(runRoot, runId, "artifacts", "final_delivery", "final-summary.md");
    await assert.rejects(() => readFile(artifactPath, "utf8"), /ENOENT/);
    assert.equal(finalResult.deliverables?.some((item) => item.artifact_id === "final_delivery/final-summary.md"), false);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; artifact_id?: string });
    assert.ok(events.some((event) => event.type === "complete_summary_available"));
    assert.equal(events.some((event) => event.type === "artifact_created" && event.artifact_id === "final_delivery/final-summary.md"), false);
  });


  it("stores task deliverables in artifacts and carries them in results", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "report.md", content: "# Report\nDone.", description: "User report" } }] };
        return { content: JSON.stringify({ status: "success", summary: "dev done", handoff: { instruction: "summarize" } }) };
      }
    };
    const runRoot = ".tmp/task-artifact-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default", permissions: { allow: ["ArtifactWrite"], ask: [], deny: [] } }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    const devResult = result.attempts.at(-1)?.result as { deliverables?: Array<{ artifact_id: string; description: string }> };
    assert.deepEqual(devResult.deliverables, [{ artifact_id: "dev/report.md", description: "User report" }]);
    const runId = await latestRunId(runRoot);
    assert.equal(await readFile(join(runRoot, runId, "artifacts", "dev", "report.md"), "utf8"), "# Report\nDone.");
  });
  it("marks complete nodes without documents as waiting for user input", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: JSON.stringify({ status: "success", summary: "missing document", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = ".tmp/complete-missing-doc-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const state = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { final_delivery: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "final_delivery", role: "final_delivery", provider: "default", permission_mode: "default", mode: "complete" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(state.status, "waiting_user");
    assert.equal(state.attempts.at(-1)?.status, "failure");
    assert.equal(state.current_node_id, "final_delivery");
    assert.equal(state.resume_checkpoint?.node_id, "final_delivery");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(runRoot, runId, "state.json"), "utf8")) as { status: string; attempts: Array<{ status: string }> };
    assert.equal(persisted.status, "waiting_user");
    assert.equal(persisted.attempts.at(-1)?.status, "failure");

    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; status?: string });
    assert.ok(events.some((event) => event.type === "node_completed" && event.status === "failure"));
    assert.ok(events.some((event) => event.type === "node_waiting_user"));
  });


  it("rejects image handoff when provider has no vision capability", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: ".tmp/image-runs" });

    await assert.rejects(() => engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x", images: ["README.md"] }), /requires vision/);
  });

  it("resumes an interrupted headless run from the current node", async () => {
    const runRoot = ".tmp/headless-interrupted-resume-runs";
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: JSON.stringify({ status: "success", summary: `call ${calls}`, handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };
    const run = await engine.run(config, "flow", { request: "x" });
    const runId = await latestRunId(runRoot);

    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(runRoot, runId, "state.json"), `${JSON.stringify({ ...run, status: "interrupted", current_node_id: "dev", resume_checkpoint: { node_id: "dev", handoff: run.handoff } }, null, 2)}\n`, "utf8"));
    const resumed = await engine.resume(config, "flow", runId, {});

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 2);
  });

  it("resumes a provider-error headless run from the saved checkpoint", async () => {
    const runRoot = `.tmp/headless-checkpoint-error-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) throw new Error("provider exploded");
        return { content: JSON.stringify({ status: "success", summary: "recovered", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "waiting_user");
    assert.equal(waiting.attempts.at(-1)?.status, "failure");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(runRoot, runId, "state.json"), "utf8")) as { status: string; resume_checkpoint?: { node_id: string } };

    assert.equal(persisted.status, "waiting_user");
    assert.equal(persisted.resume_checkpoint?.node_id, "dev");

    const resumed = await engine.resume(config, "flow", runId, { answer: "try again" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 2);
    assert.equal(resumed.resume_checkpoint, undefined);
    assert.equal(calls, 2);
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

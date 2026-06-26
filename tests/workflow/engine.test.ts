import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider, ModelRequest } from "../../src/providers/types.js";

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

  it("prepends the configured global prompt to every node system prompt", async () => {
    const systemPrompts: string[] = [];
    const provider: ModelProvider = {
      async generate(request: ModelRequest) {
        const system = request.messages.find((message) => message.role === "system")?.content;
        systemPrompts.push(String(system));
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/global-prompt-runs" });

    const result = await engine.run({
      global_prompt_file: "GLOBAL.md",
      global_prompt: "Global safety rules.",
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { a: { description: "", system_prompt: "Role A", requires: { tool_calling: false, vision: false } }, b: { description: "", system_prompt: "Role B", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }, { id: "b", role: "b", provider: "default", permission_mode: "default" }], edges: [{ from: "a", to: "b", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.equal(systemPrompts.length, 2);
    assert.match(systemPrompts[0] ?? "", /^Global safety rules\.\n\nRole A/);
    assert.match(systemPrompts[1] ?? "", /^Global safety rules\.\n\nRole B/);
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
    const requests: unknown[] = [];
    class WaitingProvider implements ModelProvider {
      async generate(request: ModelRequest) {
        requests.push(request);
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
    assert.equal(waiting.status, "pending");

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "operators" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "product").length, 1);
    const resumedMessages = JSON.stringify((requests[1] as { messages?: unknown[] }).messages);
    assert.match(resumedMessages, /need detail/);
    assert.match(resumedMessages, /operators/);
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

    assert.equal(waiting.status, "pending");
    assert.equal(waiting.current_node_id, "product");
    assert.equal(waiting.attempts[0]?.status, "waiting_user");
    assert.equal(waiting.pending_review?.node_id, "product");
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

    assert.equal(waiting.status, "pending");
    assert.equal(stillWaiting.status, "pending");
    assert.equal(stillWaiting.current_node_id, "product");
    assert.equal(stillWaiting.attempts[0]?.status, "waiting_user");
    assert.equal(calls, 1);
  });

  it("treats custom headless input during pending plan review as model context", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Plan\nOld plan.", handoff: { instruction: "old" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "revised plan", document: "# Plan\nRevised plan.", handoff: { instruction: "revised" } }) };
      }
    };
    const runRoot = `.tmp/headless-plan-review-input-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = planReviewConfig();

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "pending");

    const runId = await latestRunId(runRoot);
    const revised = await engine.resume(config, "flow", runId, { answer: "请把计划拆得更细" });

    const resumedUserMessages = requests[1]?.messages
      .filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n") ?? "";

    assert.equal(calls, 2);
    assert.equal(revised.status, "pending");
    assert.equal(revised.pending_review?.node_id, "product");
    assert.match(revised.pending_review?.document ?? "", /Revised plan/);
    assert.match(resumedUserMessages, /pending_review/);
    assert.match(resumedUserMessages, /请把计划拆得更细/);
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
    const artifactPath = join(runRoot, runId, "artifacts", "final_delivery", "node-output-1.md");
    assert.match(await readFile(artifactPath, "utf8"), /Delivery Summary/);
    assert.equal(finalResult.deliverables?.some((item) => item.artifact_id === "final_delivery/node-output-1.md"), true);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; artifact_id?: string });
    assert.ok(events.some((event) => event.type === "complete_summary_available"));
    assert.equal(events.some((event) => event.type === "artifact_created" && event.artifact_id === "final_delivery/node-output-1.md"), true);
  });


  it("writes fallback deliverables for nodes without artifacts and keeps retry attempts separate", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 2) {
          return { content: JSON.stringify({ status: "failure", summary: "reject", feedback: { defects: ["missing behavior"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: `dev attempt ${calls}`, handoff: { instruction: "next" } }) };
      }
    };
    const runRoot = `.tmp/fallback-artifact-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }], edges: [{ from: "dev", to: "test", condition: "success" }, { from: "test", to: "dev", condition: "failure" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    const devAttempts = result.attempts.filter((attempt) => attempt.node_id === "dev");
    assert.equal(devAttempts.length, 2);
    assert.deepEqual(devAttempts.map((attempt) => (attempt.result as { deliverables?: Array<{ artifact_id: string }> }).deliverables?.[0]?.artifact_id), ["dev/node-output-1.md", "dev/node-output-2.md"]);
    const runId = await latestRunId(runRoot);
    assert.match(await readFile(join(runRoot, runId, "artifacts", "dev", "node-output-1.md"), "utf8"), /dev attempt 1/);
    assert.match(await readFile(join(runRoot, runId, "artifacts", "dev", "node-output-2.md"), "utf8"), /dev attempt 3/);
    assert.match(await readFile(join(runRoot, runId, "artifacts", "test", "node-output-1.md"), "utf8"), /reject/);
  });

  it("stores task deliverables in artifacts and carries them in results", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: "我先写入报告产物。", tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "report.md", content: "# Report\nDone.", description: "User report" } }] };
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

    assert.equal(state.status, "pending");
    assert.equal(state.attempts.at(-1)?.status, "failure");
    assert.equal(state.current_node_id, "final_delivery");
    assert.equal(state.resume_checkpoint?.node_id, "final_delivery");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(runRoot, runId, "state.json"), "utf8")) as { status: string; attempts: Array<{ status: string }> };
    assert.equal(persisted.status, "pending");
    assert.equal(persisted.attempts.at(-1)?.status, "failure");

    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; status?: string });
    assert.ok(events.some((event) => event.type === "node_completed" && event.status === "failure"));
    assert.ok(events.some((event) => event.type === "node_waiting_user"));
  });


  it("turns repeated invalid needs_user_input results into a failure with a concrete question", async () => {
    const invalid = JSON.stringify({ status: "needs_user_input", summary: "need input", document: "", deliverables: [], feedback: { defects: [], change_requests: [] }, questions: [], handoff: { instruction: "", must_follow: [], known_risks: [], open_questions: [] } });
    const provider: ModelProvider = {
      async generate() {
        return { content: invalid };
      }
    };
    const runRoot = `.tmp/invalid-node-result-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const state = await engine.run({
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(state.status, "pending");
    assert.equal(state.attempts.at(-1)?.status, "failure");
    const result = state.attempts.at(-1)?.result as { questions?: Array<{ text?: string }>; summary?: string };
    assert.match(result.summary ?? "", /Invalid NodeResult|needs_user_input/i);
    assert.ok((result.questions?.length ?? 0) > 0);
    assert.match(result.questions?.[0]?.text ?? "", /节点无法继续执行|NodeResult|needs_user_input/);

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; questions?: unknown[]; status?: string });
    const waiting = events.find((event) => event.type === "node_waiting_user");
    assert.ok(waiting);
    assert.notDeepEqual(waiting?.questions, []);
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

    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(runRoot, runId, "state.json"), `${JSON.stringify({ ...run, status: "pending", current_node_id: "dev", resume_checkpoint: { node_id: "dev", handoff: run.handoff } }, null, 2)}\n`, "utf8"));
    const resumed = await engine.resume(config, "flow", runId, {});

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 2);
  });

  it("resumes a failed node with model-returned failure status and rework succeeds", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ status: "failure", summary: "rejected: not enough detail", feedback: { defects: ["missing context"], change_requests: [] }, handoff: { instruction: "fix it" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "rework accepted", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/failure-rework-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.attempts.at(-1)?.status, "failure");
    assert.equal(waiting.current_node_id, "dev");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(runRoot, runId, "state.json"), "utf8")) as { status: string; resume_checkpoint?: { node_id: string } };
    assert.equal(persisted.status, "pending");
    assert.equal(persisted.resume_checkpoint?.node_id, "dev");

    const resumed = await engine.resume(config, "flow", runId, { answer: "adding more context for rework" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(resumed.resume_checkpoint, undefined);
    assert.equal(calls, 2);

    const resumedUserMessages = requests[1]?.messages.filter((m) => m.role === "user");
    const resumedText = resumedUserMessages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join(" ");
    assert.match(resumedText, /adding more context for rework/);
  });

  it("resumes a failed node after plan approval with user rework", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Plan\nBuild feature X.", handoff: { instruction: "implement" } }) };
        }
        if (calls === 2) {
          return { content: JSON.stringify({ status: "failure", summary: "implementation rejected", feedback: { defects: ["missing tests"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "rework accepted", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/plan-failure-rework-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: {
        product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const, mode: "plan" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }
    };

    const planWaiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(planWaiting.status, "pending");
    assert.equal(planWaiting.pending_review?.node_id, "product");

    const runId = await latestRunId(runRoot);
    const approved = await engine.resume(config, "flow", runId, { answer: "Yes, continue execution by plan" });
    assert.equal(approved.status, "pending");
    assert.equal(approved.attempts.at(-1)?.status, "failure");
    assert.equal(calls, 2);

    const resumed = await engine.resume(config, "flow", runId, { answer: "add unit tests and retry" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 3);

    const devMessages = requests[2]?.messages.filter((m) => m.role === "user");
    const devText = devMessages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join(" ");
    assert.match(devText, /add unit tests and retry/);
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
    assert.equal(waiting.status, "pending");
    assert.equal(waiting.attempts.at(-1)?.status, "failure");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(runRoot, runId, "state.json"), "utf8")) as { status: string; resume_checkpoint?: { node_id: string } };

    assert.equal(persisted.status, "pending");
    assert.equal(persisted.resume_checkpoint?.node_id, "dev");

    const resumed = await engine.resume(config, "flow", runId, { answer: "try again" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
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

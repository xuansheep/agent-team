import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { planModeExitHandoffMarker, planModeExitPlanExistsMarker } from "../../src/plans/planSession.js";
import { RunStore } from "../../src/storage/runStore.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { CONVERSATION_INTERRUPTED_QUESTION_ID, CONVERSATION_INTERRUPTED_TEXT } from "../../src/workflow/state.js";
import { testDispatcher } from "../helpers/projectConfig.js";

class FakeProvider implements ModelProvider {
  async generate() {
    return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
  }
}

describe("WorkflowEngine", () => {
  it("persists the actual project path from prepared project storage", async () => {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const projectPath = join(process.cwd(), ".tmp", `project-path-${suffix}`);
    const projectDir = join(process.cwd(), ".tmp", `project-storage-${suffix}`);
    const projectStorage = {
      homeDir: join(process.cwd(), ".tmp", `home-${suffix}`),
      projectsDir: join(process.cwd(), ".tmp", `projects-${suffix}`),
      projectDir,
      projectPath,
      projectKey: `project-${suffix}`
    };
    const sessionId = `session-${suffix}`;
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: projectPath, projectStorage });

    await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { sessionId });

    const metadata = await new SessionStore(projectStorage).loadMetadata(sessionId);
    assert.equal(metadata?.projectPath, projectPath);
    assert.notEqual(metadata?.projectPath, projectDir);
    assert.throws(
      () => new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: projectPath, projectStorage, runRoot: projectDir }),
      /projectStorage and runRoot are mutually exclusive/
    );
  });

  it("runs two successful nodes in order", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: ".tmp/test-runs" });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } }, b: { description: "", system_prompt: "B", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }, { id: "b", role: "b", provider: "default", permission_mode: "default" }], edges: [{ from: "a", to: "b", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["a", "b"]);
  });

  it("runs successful nodes in node order without edges", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: `.tmp/ordered-runs-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } },
        b: { description: "", system_prompt: "B", requires: { tool_calling: false, vision: false } },
        c: { description: "", system_prompt: "C", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }, { id: "b", role: "b", provider: "default", permission_mode: "default" }, { id: "c", role: "c", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["a", "b", "c"]);
  });

  it("returns to the previous node on ordered routing failure", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 2) return { content: JSON.stringify({ direction: "backward", summary: "reject", feedback: { defects: ["missing behavior"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        return { content: JSON.stringify({ direction: "forward", summary: "ok", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/ordered-failure-runs-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } },
        final: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }, { id: "final", role: "final", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["dev", "test", "final"]);
    assert.equal(result.attempts.find((attempt) => attempt.node_id === "dev")?.activation, 2);
    assert.equal(result.attempts.find((attempt) => attempt.node_id === "test")?.activation, 2);
  });

  it("rejects direct user questions from non-first nodes", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 2) return { content: JSON.stringify({ direction: "backward", summary: "need decision", questions: [{ id: "q1", text: "Proceed?", required: true }] }) };
        return { content: JSON.stringify({ direction: "forward", summary: "ok", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/ordered-user-input-runs-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "paused");
    assert.deepEqual(result.attempts.map((attempt) => `${attempt.node_id}:${attempt.status}`), ["dev:completed", "test:failure"]);
    assert.equal(calls, 2);
  });

  it("pauses when the first ordered node fails", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: JSON.stringify({ direction: "backward", summary: "blocked", feedback: { defects: ["missing input"], change_requests: [] }, handoff: { instruction: "ask user" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/ordered-first-failure-runs-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "paused");
    assert.deepEqual(result.attempts.map((attempt) => `${attempt.node_id}:${attempt.status}`), ["dev:failure"]);
  });

  it("uses explicit directions even when programmatic configs contain legacy edges", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 2) return { content: JSON.stringify({ direction: "backward", summary: "reject", feedback: { defects: ["missing behavior"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        return { content: JSON.stringify({ direction: "forward", summary: "ok", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/explicit-success-runs-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } },
        b: { description: "", system_prompt: "B", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }, { id: "b", role: "b", provider: "default", permission_mode: "default" }], edges: [{ from: "a", to: "b", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["a", "b"]);
    assert.equal(result.attempts.every((attempt) => attempt.activation === 2), true);
    assert.equal(calls, 4);
  });

  it("records model usage as workflow run events", async () => {
    const runRoot = `.tmp/model-usage-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate() {
        return {
          content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }),
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
          stopReason: "stop"
        };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(await runDirForRun(runRoot, runId), "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; node_id?: string; attempt?: number; activation?: number; model?: string; usage?: unknown; stop_reason?: string; ts: string; seq: number });
    const responseEvent = events.find((event) => event.type === "model_response_recorded");
    const usageEvent = events.find((event) => event.type === "model_usage_recorded");

    assert.deepEqual(responseEvent, {
      type: "model_response_recorded",
      diagnostics: (responseEvent as { diagnostics?: unknown } | undefined)?.diagnostics,
      node_id: "a",
      attempt: 1,
      activation: 1,
      model: "gpt-test",
      usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
      stop_reason: "stop",
      ts: responseEvent?.ts,
      seq: responseEvent?.seq
    });
    assert.deepEqual(usageEvent, {
      type: "model_usage_recorded",
      node_id: "a",
      attempt: 1,
      activation: 1,
      model: "gpt-test",
      usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
      stop_reason: "stop",
      ts: usageEvent?.ts,
      seq: usageEvent?.seq
    });
    const sessionMetadata = await new SessionStore(runRoot).loadMetadata(runId);
    assert.equal(sessionMetadata?.modelRequestCount, 1);
    assert.deepEqual(sessionMetadata?.usage, { inputTokens: 11, cachedInputTokens: 0, outputTokens: 13, totalTokens: 24 });
  });

  it("applies Plan Mode requested Bash prompt permissions during workflow execution", async () => {
    const runRoot = `.tmp/plan-requested-permission-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "checking test runner",
            tool_calls: [{ id: "call-bash", name: "Bash", input: { command: "node --test --help", timeout_ms: 30000 } }]
          };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", {
      original_input: { request: "build" },
      approved_plan: "Run the relevant tests.",
      plan_requested_permissions: [{ tool: "Bash", prompt: "run tests" }]
    });

    assert.equal(result.status, "awaiting_bus");
    assert.equal(calls, 2);

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(await runDirForRun(runRoot, runId), "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; tool?: string });
    assert.equal(events.some((event) => event.type === "permission_requested"), false);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool === "Bash"), true);
  });

  it("keeps Plan Mode requested Bash prompt permissions after workflow resume", async () => {
    const runRoot = `.tmp/plan-requested-permission-resume-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: JSON.stringify({ direction: "forward", summary: "a done", handoff: { instruction: "continue" } }) };
        if (calls === 2) return { content: JSON.stringify({ direction: "backward", summary: "need tests", feedback: { defects: ["missing tests"], change_requests: [] }, handoff: { instruction: "run tests" } }) };
        if (calls === 3) {
          return {
            content: "checking test runner",
            tool_calls: [{ id: "call-bash", name: "Bash", input: { command: "node --test --help", timeout_ms: 30000 } }]
          };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "b done", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } },
        b: { description: "", system_prompt: "B", requires: { tool_calling: true, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" as const }, { id: "b", role: "b", provider: "default", permission_mode: "default" as const }], edges: [{ from: "a", to: "b", condition: "success" as const }] } }
    };

    const failed = await engine.run(config, "flow", {
      original_input: { request: "build" },
      approved_plan: "Run the relevant tests.",
      plan_requested_permissions: [{ tool: "Bash", prompt: "run tests" }]
    });

    assert.equal(failed.status, "awaiting_bus");
    // The runtime treats Bash and PowerShell alike, so an approved prompt must cover both or it
    // is dead on Windows, where the model reaches for PowerShell.
    assert.deepEqual(failed.plan_requested_permission_rules, ["Bash(prompt:run tests)", "PowerShell(prompt:run tests)"]);

    assert.equal(calls, 5);
  });

  it("prepends the configured global prompt to every node system prompt", async () => {
    const systemPrompts: string[] = [];
    const provider: ModelProvider = {
      async generate(request: ModelRequest) {
        const system = request.messages
          .filter((message) => message.role === "system")
          .map((message) => String(message.content))
          .find((content) => /^Global safety rules\.\n\nRole [AB]/.test(content));
        systemPrompts.push(String(system));
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/global-prompt-runs" });

    const result = await engine.run({
      global_prompt: "Global safety rules.",
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { a: { description: "", system_prompt: "Role A", requires: { tool_calling: false, vision: false } }, b: { description: "", system_prompt: "Role B", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }, { id: "b", role: "b", provider: "default", permission_mode: "default" }], edges: [{ from: "a", to: "b", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
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
          return { content: JSON.stringify({ direction: "backward", summary: "reject", feedback: { defects: ["missing behavior"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "ok", handoff: { instruction: "next" } }) };
      }
    }

    const engine = new WorkflowEngine({ providerFactory: () => new FeedbackProvider(), cwd: process.cwd(), runRoot: ".tmp/test-runs" });
    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } },
        final: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }, { id: "final", role: "final", provider: "default", permission_mode: "default" }], edges: [{ from: "dev", to: "test", condition: "success" }, { from: "test", to: "final", condition: "success" }, { from: "test", to: "dev", condition: "failure" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    assert.equal(result.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(result.attempts.find((attempt) => attempt.node_id === "dev")?.activation, 2);
  });

  it("resumes a waiting node with user input", async () => {
    let calls = 0;
    const requests: unknown[] = [];
    class WaitingProvider implements ModelProvider {
      async generate(request: ModelRequest) {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ direction: "backward", summary: "need detail", questions: [{ id: "q1", text: "What is the target user?", required: true }] }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "accepted answer", handoff: { instruction: "continue" } }) };
      }
    }

    const runRoot = ".tmp/resume-runs";
    const engine = new WorkflowEngine({ providerFactory: () => new WaitingProvider(), cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "waiting_user");

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "operators" });

    assert.equal(resumed.status, "awaiting_bus");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "product").length, 1);
    const resumedMessages = JSON.stringify((requests[1] as { messages?: unknown[] }).messages);
    assert.match(resumedMessages, /need detail/);
    assert.match(resumedMessages, /operators/);
  });

  it("persists a run-level permission mode override", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: `.tmp/run-permission-mode-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { permissionMode: "fullAccess" });

    assert.equal(result.status, "awaiting_bus");
    assert.equal(result.run_permission_mode, "fullAccess");
  });

  it("turns clear-context approved plans into a tui-code style implementation request", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/clear-context-plan-${Date.now()}` });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default" as const, permission_mode: "default" as const }], edges: [] } }
    };

    await engine.run(config, "flow", {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it.",
      plan_file_path: ".session/plans/session-1.md",
      plan_approval_feedback: "Also update README."
    }, { permissionMode: "default", clearContext: true });

    const firstUserText = nonRuntimeUserText(requests[0]);

    assert.match(firstUserText, /"request": "Implement the following plan:\\n\\n# Plan\\nBuild it\.\\n\\nUser feedback on this plan: Also update README\."/);
    assert.match(firstUserText, /"clear_context": true/);
    assert.match(firstUserText, /"approved_plan": "# Plan\\nBuild it\."/);

    requests.length = 0;
    await engine.run(config, "flow", {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it."
    }, { permissionMode: "default" });

    const keepContextUserText = nonRuntimeUserText(requests[0]);
    assert.doesNotMatch(keepContextUserText, /Implement the following plan/);
    assert.doesNotMatch(keepContextUserText, /"clear_context": true/);
  });

  it("does not persist internal Plan Mode handoff markers in run start metadata", async () => {
    const runRoot = `.tmp/plan-marker-public-input-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "Ready empty exit.", [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: false });

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(await runDirForRun(runRoot, runId), "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; input?: unknown });
    const started = events.find((event) => event.type === "run_started");
    const startedText = JSON.stringify(started?.input);
    assert.doesNotMatch(startedText, new RegExp(planModeExitHandoffMarker));
    assert.doesNotMatch(startedText, new RegExp(planModeExitPlanExistsMarker));

    const summaries = await new RunStore(runRoot).listRuns();
    assert.equal(summaries[0]?.inputPreview, "Ready empty exit.");

    const system = allRequestText(requests[0]);
    const user = nonRuntimeUserText(requests[0]);
    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.doesNotMatch(user, new RegExp(planModeExitHandoffMarker));
    assert.doesNotMatch(user, new RegExp(planModeExitPlanExistsMarker));
  });

  it("uses run-level fullAccess permissions for workflow tool execution", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: "checking", tool_calls: [{ id: "tool-1", name: "Bash", input: { command: "echo workflow-full-access" } }] };
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/run-full-access-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { permissionMode: "fullAccess" });

    assert.equal(result.status, "awaiting_bus");
    assert.equal(calls, 2);
  });

  it("automatically stops managed processes before completing a workflow node", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "starting server",
            tool_calls: [{
              id: "process-start-1",
              name: "ProcessStart",
              input: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }
            }]
          };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const runRoot = `.tmp/managed-process-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "fullAccess" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    const runId = await latestRunId(runRoot);
    const events = await new RunStore(runRoot).loadEvents(runId);
    const started = events.find((event) => event.type === "managed_process_started");
    const stopped = events.find((event) => event.type === "managed_process_stopped");
    assert.ok(started && started.type === "managed_process_started");
    assert.ok(stopped && stopped.type === "managed_process_stopped");
    assert.equal(stopped.process_id, started.process_id);
    assert.equal(stopped.reason, "node_complete");
    await waitForPidExit(started.pid, 3000);
    assert.equal(isPidRunning(started.pid), false);
    assert.ok(events.findIndex((event) => event.type === "managed_process_stopped")
      < events.findIndex((event) => event.type === "node_completed"));
  });

  it("uses run-level fullAccess permissions for workflow edit tools without Auto Mode attachment", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const runRoot = `.tmp/run-full-access-artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) return { content: "writing artifact", tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "full-access.md", content: "# Full access\nDone.", description: "Full access artifact" } }] };
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { permissionMode: "fullAccess" });

    assert.equal(result.status, "awaiting_bus");
    assert.equal(result.run_permission_mode, "fullAccess");
    assert.equal(calls, 2);
    const firstSystem = requests[0]?.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n") ?? "";
    assert.doesNotMatch(firstSystem, /ATTACHMENT auto_mode/);
    assert.doesNotMatch(firstSystem, /## Auto Mode Active/);

    const runId = await latestRunId(runRoot);
    const runDir = await runDirForRun(runRoot, runId);
    const events = (await readFile(join(runDir, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; tool?: string; result?: { attempts?: unknown[] } });
    assert.equal(events.some((event) => event.type === "permission_requested"), false);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool === "ArtifactWrite"), true);
    assert.equal(events.find((event) => event.type === "run_completed")?.result?.attempts, undefined);
    const persisted = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as { revision?: number; resume_checkpoint?: { dialogue_messages?: unknown[] } };
    assert.equal(persisted.revision, 2);
    assert.equal(persisted.resume_checkpoint?.dialogue_messages, undefined);
  });

  it("carries a node summary document to the bus boundary without finalizing the task", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: JSON.stringify({ direction: "forward", summary: "dev done", handoff: { instruction: "summarize" } }) };
        return { content: JSON.stringify({ direction: "forward", summary: "final done", document: "# Delivery Summary\nEverything is complete.", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = ".tmp/final-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        final_delivery: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "final_delivery", role: "final_delivery", provider: "default", permission_mode: "default" }], edges: [{ from: "dev", to: "final_delivery", condition: "success" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    assert.deepEqual(result.attempts.map((attempt) => attempt.node_id), ["dev", "final_delivery"]);
    const finalResult = result.attempts.at(-1)?.result as { document?: string; deliverables?: Array<{ artifact_id: string; description: string }> };
    assert.match(String(finalResult.document), /Delivery Summary/);

    const runId = await latestRunId(runRoot);
    const artifactPath = join(await runDirForRun(runRoot, runId), "artifacts", "final_delivery", "r0001-node-output-1-a1.md");
    assert.match(await readFile(artifactPath, "utf8"), /Delivery Summary/);
    assert.equal(finalResult.deliverables?.some((item) => item.artifact_id === "final_delivery/node-output-1-a1.md@r1"), true);
    const events = (await readFile(join(await runDirForRun(runRoot, runId), "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; artifact_id?: string });
    assert.equal(events.some((event) => event.type === "complete_summary_available"), false);
    assert.equal(events.some((event) => event.type === "run_awaiting_bus"), true);
    assert.equal(events.some((event) => event.type === "artifact_created" && event.artifact_id === "final_delivery/node-output-1-a1.md@r1"), true);
  });


  it("writes fallback deliverables for nodes without artifacts and keeps retry attempts separate", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 2) {
          return { content: JSON.stringify({ direction: "backward", summary: "reject", feedback: { defects: ["missing behavior"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: `dev attempt ${calls}`, handoff: { instruction: "next" } }) };
      }
    };
    const runRoot = `.tmp/fallback-artifact-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } },
        test: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }, { id: "test", role: "test", provider: "default", permission_mode: "default" }], edges: [{ from: "dev", to: "test", condition: "success" }, { from: "test", to: "dev", condition: "failure" }] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    const devAttempts = result.attempts.filter((attempt) => attempt.node_id === "dev");
    assert.equal(devAttempts.length, 1);
    assert.equal(devAttempts[0]?.activation, 2);
    assert.deepEqual(devAttempts[0]?.activations?.map((activation) => (activation.result as { deliverables?: Array<{ artifact_id: string }> }).deliverables?.[0]?.artifact_id), ["dev/node-output-1-a1.md@r1", "dev/node-output-1-a2.md@r1"]);
    const runId = await latestRunId(runRoot);
    assert.match(await readFile(join(await runDirForRun(runRoot, runId), "artifacts", "dev", "r0001-node-output-1-a1.md"), "utf8"), /dev attempt 1/);
    assert.match(await readFile(join(await runDirForRun(runRoot, runId), "artifacts", "dev", "r0001-node-output-1-a2.md"), "utf8"), /dev attempt 3/);
    assert.match(await readFile(join(await runDirForRun(runRoot, runId), "artifacts", "test", "r0001-node-output-1-a1.md"), "utf8"), /reject/);
  });

  it("stores task deliverables in artifacts and carries them in results", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: "我先写入报告产物。", tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "report.md", content: "# Report\nDone.", description: "User report" } }] };
        return { content: JSON.stringify({ direction: "forward", summary: "dev done", handoff: { instruction: "summarize" } }) };
      }
    };
    const runRoot = ".tmp/task-artifact-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default", permissions: { allow: ["ArtifactWrite"], ask: [], deny: [] } }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "awaiting_bus");
    const devResult = result.attempts.at(-1)?.result as { deliverables?: Array<{ artifact_id: string; description: string }> };
    assert.deepEqual(devResult.deliverables, [{ artifact_id: "dev/report.md@r1", description: "User report" }]);
    const runId = await latestRunId(runRoot);
    assert.equal(await readFile(join(await runDirForRun(runRoot, runId), "artifacts", "dev", "r0001-report.md"), "utf8"), "# Report\nDone.");
  });
  it("keeps nodes without explicit documents at the bus boundary with a fallback deliverable", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: JSON.stringify({ direction: "forward", summary: "missing document", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = ".tmp/complete-missing-doc-runs";
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const state = await engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { final_delivery: { description: "", system_prompt: "F", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "final_delivery", role: "final_delivery", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(state.attempts.at(-1)?.status, "completed");
    assert.equal(state.current_node_id, "final_delivery");
    assert.equal(state.resume_checkpoint?.node_id, "final_delivery");
    const nodeResult = state.attempts.at(-1)?.result as { deliverables?: Array<{ artifact_id: string }> };
    assert.equal(nodeResult.deliverables?.[0]?.artifact_id, "final_delivery/node-output-1-a1.md@r1");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(await runDirForRun(runRoot, runId), "state.json"), "utf8")) as { status: string; attempts: Array<{ status: string }> };
    assert.equal(persisted.status, "awaiting_bus");
    assert.equal(persisted.attempts.at(-1)?.status, "completed");

    const events = (await readFile(join(await runDirForRun(runRoot, runId), "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; status?: string });
    assert.ok(events.some((event) => event.type === "node_completed" && event.status === "completed"));
    assert.ok(events.some((event) => event.type === "run_awaiting_bus"));
    assert.equal(events.some((event) => event.type === "node_waiting_user"), false);
  });


  it("turns repeated invalid needs_user_input results into a failure with the unified interruption prompt", async () => {
    const invalid = JSON.stringify({ direction: "backward", summary: "need input", document: "", deliverables: [], feedback: { defects: [], change_requests: [] }, questions: [], handoff: { instruction: "", must_follow: [], known_risks: [], open_questions: [] } });
    const provider: ModelProvider = {
      async generate() {
        return { content: invalid };
      }
    };
    const runRoot = `.tmp/invalid-node-result-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const state = await engine.run({
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(state.status, "paused");
    assert.equal(state.attempts.at(-1)?.status, "failure");
    const result = state.attempts.at(-1)?.result as { questions?: Array<{ id?: string; text?: string; required?: boolean }>; summary?: string };
    assert.match(result.summary ?? "", /Invalid NodeResult|concrete user question/i);
    assert.deepEqual(result.questions, [{ id: CONVERSATION_INTERRUPTED_QUESTION_ID, text: CONVERSATION_INTERRUPTED_TEXT, required: true }]);

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(await runDirForRun(runRoot, runId), "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; questions?: unknown[]; status?: string });
    const waiting = events.find((event) => event.type === "node_waiting_user");
    assert.ok(waiting);
    assert.deepEqual(waiting?.questions, [{ id: CONVERSATION_INTERRUPTED_QUESTION_ID, text: CONVERSATION_INTERRUPTED_TEXT, required: true }]);
  });

  it("rejects image handoff when provider has no vision capability", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: ".tmp/image-runs" });

    await assert.rejects(() => engine.run({
      providers: { default: { type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
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
        return { content: JSON.stringify({ direction: "forward", summary: `call ${calls}`, handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };
    const run = await engine.run(config, "flow", { request: "x" });
    const runId = await latestRunId(runRoot);
    const runDir = await runDirForRun(runRoot, runId);

    await import("node:fs/promises").then(({ writeFile }) => writeFile(join(runDir, "state.json"), `${JSON.stringify({ ...run, status: "pending", current_node_id: "dev", resume_checkpoint: { node_id: "dev", handoff: run.handoff } }, null, 2)}\n`, "utf8"));
    const resumed = await engine.resume(config, "flow", runId, {});

    assert.equal(resumed.status, "awaiting_bus");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(resumed.attempts.find((attempt) => attempt.node_id === "dev")?.activation, 2);
  });

  it("resumes a failed node with model-returned failure status and rework succeeds", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ direction: "backward", summary: "rejected: not enough detail", feedback: { defects: ["missing context"], change_requests: [] }, handoff: { instruction: "fix it" } }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "rework accepted", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/failure-rework-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "paused");
    assert.equal(waiting.attempts.at(-1)?.status, "failure");
    assert.equal(waiting.current_node_id, "dev");

    const runId = await latestRunId(runRoot);
    const persisted = JSON.parse(await readFile(join(await runDirForRun(runRoot, runId), "state.json"), "utf8")) as { status: string; resume_checkpoint?: { node_id: string } };
    assert.equal(persisted.status, "paused");
    assert.equal(persisted.resume_checkpoint?.node_id, "dev");

    const resumed = await engine.resume(config, "flow", runId, { answer: "adding more context for rework" });

    assert.equal(resumed.status, "awaiting_bus");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(resumed.current_node_id, "dev");
    assert.equal(resumed.resume_checkpoint?.node_id, "dev");
    assert.equal(resumed.resume_checkpoint?.attempt, 1);
    assert.equal(resumed.resume_checkpoint?.activation, 2);
    assert.equal(calls, 2);

    const resumedUserMessages = requests[1]?.messages.filter((m) => m.role === "user");
    const resumedText = resumedUserMessages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join(" ");
    assert.match(resumedText, /adding more context for rework/);
  });

  it("resumes a failed node with user rework", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ direction: "backward", summary: "implementation rejected", feedback: { defects: ["missing tests"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "rework accepted", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/failure-rework-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const failed = await engine.run(config, "flow", { request: "x" });
    assert.equal(failed.status, "paused");
    assert.equal(failed.attempts.at(-1)?.status, "failure");

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "add unit tests and retry" });

    assert.equal(resumed.status, "awaiting_bus");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 2);

    const devMessages = requests[1]?.messages.filter((m) => m.role === "user");
    const devText = devMessages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join(" ");
    assert.match(devText, /add unit tests and retry/);
  });

  it("recovers the latest incoming handoff when resuming a legacy stale checkpoint", async () => {
    const runRoot = `.tmp/legacy-stale-handoff-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requests: ModelRequest[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ direction: "forward", summary: "UI ready", handoff: { instruction: "实现4卡布局" } }) };
        }
        if (calls === 2) {
          return { content: JSON.stringify({ direction: "forward", summary: "Implementation ready", handoff: { instruction: "Verify" } }) };
        }
        if (calls === 3) {
          return {
            content: JSON.stringify({
              direction: "backward",
              summary: "Layout defect",
              feedback: { defects: ["Only four cards"], change_requests: [] },
              handoff: { instruction: "修复为8卡布局" }
            })
          };
        }
        if (calls === 4) throw new Error("interrupted after return transition");
        if (calls === 5) {
          return { content: JSON.stringify({ direction: "forward", summary: "Eight cards implemented", handoff: { instruction: "Retest" } }) };
        }
        return {
          content: JSON.stringify({
            direction: "forward",
            summary: "Verified",
            document: "# Delivery\n\nEight cards verified.",
            handoff: { instruction: "Deliver" }
          })
        };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const role = { description: "", system_prompt: "Role", requires: { tool_calling: false, vision: false } };
    const config = {
      providers: {
        default: {
          type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true },
          base_url: "https://api.example.test/v1",
          api_key: "test-key",
          default_model: "gpt-test",
          capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
        }
      },
      dispatcher: testDispatcher,
      roles: { ui: role, developer: role, tester: role },
      workflows: {
        flow: {
          nodes: [
            { id: "ui", role: "ui", provider: "default", permission_mode: "default" as const },
            { id: "developer", role: "developer", provider: "default", permission_mode: "default" as const },
            { id: "tester", role: "tester", provider: "default", permission_mode: "default" as const }
          ],
          edges: []
        }
      }
    };

    const paused = await engine.run(config, "flow", { request: "Build cards" });
    assert.equal(paused.status, "paused");
    assert.equal(paused.current_node_id, "developer");

    const runId = await latestRunId(runRoot);
    const statePath = join(await runDirForRun(runRoot, runId), "state.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      [key: string]: unknown;
      resume_checkpoint?: { [key: string]: unknown };
    };
    assert.ok(persisted.resume_checkpoint);
    const staleHandoff = {
      from: "ui",
      to: "developer",
      instruction: "实现4卡布局",
      must_follow: [],
      known_risks: [],
      open_questions: [],
      references: [],
      iteration: 1
    };
    const { attempt: _legacyAttempt, activation: _legacyActivation, ...legacyCheckpoint } = persisted.resume_checkpoint;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(
      statePath,
      `${JSON.stringify({
        ...persisted,
        handoff: staleHandoff,
        resume_checkpoint: { ...legacyCheckpoint, handoff: staleHandoff }
      }, null, 2)}\n`,
      "utf8"
    ));

    const completed = await engine.resume(config, "flow", runId, { answer: "继续修复" });

    assert.equal(completed.status, "awaiting_bus");
    const resumedDeveloperContext = requests[4]?.messages.find((message) =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes('"node_id": "developer"')
    );
    assert.ok(resumedDeveloperContext && typeof resumedDeveloperContext.content === "string");
    const recoveredHandoff = JSON.parse(resumedDeveloperContext.content).handoff as {
      instruction?: string;
      previous_handoff?: { instruction?: string };
      user_input?: unknown;
    };
    assert.equal(recoveredHandoff.instruction, "修复为8卡布局");
    assert.equal(recoveredHandoff.previous_handoff?.instruction, "实现4卡布局");
    assert.match(JSON.stringify(requests[4]?.messages), /继续修复/);
  });

  it("resumes a provider-error headless run with the real failure before the user's next turn", async () => {
    const runRoot = `.tmp/headless-checkpoint-error-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let calls = 0;
    const requests: ModelRequest[] = [];
    const cause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) throw new Error("provider exploded", { cause });
        return { content: JSON.stringify({ direction: "forward", summary: "explained without retrying tools", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const waiting = await engine.run(config, "flow", { request: "x" });
    assert.equal(waiting.status, "paused");
    assert.equal(waiting.attempts.at(-1)?.status, "failure");

    const runId = await latestRunId(runRoot);
    const checkpointError = waiting.resume_checkpoint?.dialogue_messages?.find((message) => message.role === "assistant" && message.is_error);
    assert.match(String(checkpointError?.content), /provider exploded/);
    assert.match(String(checkpointError?.content), /cause\.code: ECONNRESET/);

    const persisted = JSON.parse(await readFile(join(await runDirForRun(runRoot, runId), "state.json"), "utf8")) as {
      status: string;
      resume_checkpoint?: { node_id: string; dialogue_cursor?: number; dialogue_messages?: Array<{ role: string; content: string; is_error?: boolean }> };
    };
    assert.equal(persisted.status, "paused");
    assert.equal(persisted.resume_checkpoint?.node_id, "dev");
    assert.equal(persisted.resume_checkpoint?.dialogue_messages, undefined);
    assert.ok((persisted.resume_checkpoint?.dialogue_cursor ?? 0) > 0);
    const runStore = new RunStore(runRoot);
    const hydrated = await runStore.loadState(runId);
    assert.equal(hydrated.resume_checkpoint?.dialogue_messages?.some((message) => message.role === "assistant" && message.is_error), true);

    const transcriptBeforeResume = await new SessionStore(runRoot).loadTranscript(runId);
    assert.equal(transcriptBeforeResume.some((entry) =>
      entry.phase === "workflow" && entry.message.role === "assistant" && entry.message.is_error && String(entry.message.content).includes("ECONNRESET")
    ), true);

    const resumed = await engine.resume(config, "flow", runId, { answer: "为什么执行失败了" });

    assert.equal(resumed.status, "awaiting_bus");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(resumed.current_node_id, "dev");
    assert.equal(resumed.resume_checkpoint?.node_id, "dev");
    assert.equal(resumed.resume_checkpoint?.attempt, 1);
    assert.equal(resumed.resume_checkpoint?.activation, 2);
    assert.equal(calls, 2);

    const resumedMessages = requests[1]?.messages ?? [];
    const errorIndex = resumedMessages.findIndex((message) => message.role === "assistant" && message.is_error);
    const questionIndex = resumedMessages.findIndex((message) => message.role === "user" && requestMessageText(message).includes("为什么执行失败了"));
    assert.ok(errorIndex >= 0);
    assert.ok(questionIndex > errorIndex);

    const events = await runStore.loadEvents(runId);
    assert.equal(events.some((event) => event.type === "tool_invoked"), false);

    const transcriptAfterResume = await new SessionStore(runRoot).loadTranscript(runId);
    const transcriptErrorIndex = transcriptAfterResume.findIndex((entry) => entry.message.role === "assistant" && entry.message.is_error);
    const transcriptQuestionIndex = transcriptAfterResume.findIndex((entry) => entry.message.role === "user" && String(entry.message.content).includes("为什么执行失败了"));
    assert.ok(transcriptErrorIndex >= 0);
    assert.ok(transcriptQuestionIndex > transcriptErrorIndex);
    assert.equal(transcriptAfterResume.filter((entry) => entry.message.role === "assistant" && entry.message.is_error).length, 1);
  });

  it("lets a non-vision tester start after developer AttachImage", async () => {
    const imagePath = join(process.cwd(), ".tmp", "engine-artifact-" + Date.now().toString() + ".png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
    const requests: ModelRequest[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return { content: "attach screenshot", tool_calls: [{ id: "attach-1", name: "AttachImage", input: { path: imagePath } }] };
        }
        if (calls === 2) return { content: JSON.stringify({ direction: "forward", summary: "developer done", handoff: { instruction: "verify" } }) };
        return { content: JSON.stringify({ direction: "forward", summary: "verified", document: "# Verified", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = join(process.cwd(), ".tmp", "artifact-handoff-runs-" + Date.now().toString());
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const state = await engine.run({
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: {
        developer: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } },
        tester: { description: "", system_prompt: "T", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: {
        nodes: [
          { id: "developer", role: "developer", provider: "default", permission_mode: "fullAccess" as const },
          { id: "tester", role: "tester", provider: "default", permission_mode: "fullAccess" as const }
        ],
        edges: []
      } }
    }, "flow", { request: "build" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(calls, 3);
    const testerContext = requests[2]?.messages.find((message) => message.role === "user" && !message.metadata?.runtimeAttachment);
    assert.equal(typeof testerContext?.content, "string");
    assert.match(String(testerContext?.content), /"kind": "image"/);
    assert.match(String(testerContext?.content), /provider does not support vision/);
  });

  it("records workflow Bash deny rules for compound commands and continues execution", async () => {
    const command = "cd /d/work/code-ai/random && (pkill -f \"http.server 8137\" 2>/dev/null; pkill -f \"8137\" 2>/dev/null); rm -f weather-desktop.png; rm -rf .playwright-mcp; ls -la";
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return { content: "cleanup", tool_calls: [{ id: "bash-denied", name: "Bash", input: { command } }] };
        }
        const denial = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "bash-denied");
        assert.match(String(denial?.content), /Permission denied for Bash: Bash\(rm \*\)/);
        return { content: JSON.stringify({ direction: "forward", summary: "continued after denial", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = join(process.cwd(), ".tmp", "compound-deny-runs-" + Date.now().toString());
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const state = await engine.run({
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { developer: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: {
        permissions: { allow: [], ask: [], deny: ["Bash(rm *)"] },
        nodes: [{ id: "developer", role: "developer", provider: "default", permission_mode: "fullAccess" as const, permissions: { allow: ["Bash"], ask: [], deny: [] } }],
        edges: []
      } }
    }, "flow", { request: "build" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(calls, 2);
    const runId = await latestRunId(runRoot);
    const events = await new RunStore(runRoot).loadEvents(runId);
    const failure = events.find((event) => event.type === "tool_failed" && event.tool === "Bash");
    assert.match(failure && failure.type === "tool_failed" ? failure.error : "", /Bash\(rm \*\)/);
    assert.equal(events.some((event) => event.type === "tool_invoked" && event.tool === "Bash"), false);
    assert.equal(events.some((event) => event.type === "node_waiting_user"), false);
  });


  it("records node Bash deny rules and continues execution", async () => {
    const command = "rm -rf dist";
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return { content: "cleanup", tool_calls: [{ id: "node-bash-denied", name: "Bash", input: { command } }] };
        }
        const denial = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "node-bash-denied");
        assert.match(String(denial?.content), /Permission denied for Bash: Bash\(rm \*\)/);
        return { content: JSON.stringify({ direction: "forward", summary: "continued after node denial", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = join(process.cwd(), ".tmp", "node-deny-runs-" + Date.now().toString());
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const state = await engine.run({
      providers: { default: { type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true }, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      dispatcher: testDispatcher,
      roles: { developer: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: {
        nodes: [{ id: "developer", role: "developer", provider: "default", permission_mode: "fullAccess" as const, permissions: { allow: ["Bash"], ask: [], deny: ["Bash(rm *)"] } }],
        edges: []
      } }
    }, "flow", { request: "build" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(calls, 2);
    const runId = await latestRunId(runRoot);
    const events = await new RunStore(runRoot).loadEvents(runId);
    assert.equal(events.some((event) => event.type === "tool_failed" && event.tool_call_id === "node-bash-denied"), true);
    assert.equal(events.some((event) => event.type === "tool_invoked" && event.tool_call_id === "node-bash-denied"), false);
    assert.equal(events.some((event) => event.type === "node_waiting_user"), false);
  });

});

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requestMessageText(message: ModelRequest["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function allRequestText(request: ModelRequest | undefined): string {
  return request?.messages.map(requestMessageText).join("\n\n") ?? "";
}

function nonRuntimeUserText(request: ModelRequest | undefined): string {
  return request?.messages
    .filter((message) => message.role === "user" && !message.metadata?.runtimeAttachment)
    .map(requestMessageText)
    .join("\n\n") ?? "";
}

async function latestRunId(root: string): Promise<string> {
  return (await new RunStore(root).listRuns({ limit: 1 }))[0]?.runId ?? "";
}

async function runDirForRun(root: string, runId: string): Promise<string> {
  return (await new RunStore(root).listRuns()).find((run) => run.runId === runId)?.runDir ?? join(root, runId);
}

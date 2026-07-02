import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { planModeExitHandoffMarker, planModeExitPlanExistsMarker } from "../../src/plans/planSession.js";
import { RunStore } from "../../src/storage/runStore.js";

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

  it("records model usage as workflow run events", async () => {
    const runRoot = `.tmp/model-usage-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate() {
        return {
          content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }),
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
          stopReason: "stop"
        };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" });

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; node_id?: string; attempt?: number; model?: string; usage?: unknown; stop_reason?: string; ts: string; seq: number });
    const usageEvent = events.find((event) => event.type === "model_usage_recorded");

    assert.deepEqual(usageEvent, {
      type: "model_usage_recorded",
      node_id: "a",
      attempt: 1,
      model: "gpt-test",
      usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
      stop_reason: "stop",
      ts: usageEvent?.ts,
      seq: usageEvent?.seq
    });
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
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      roles: { a: { description: "", system_prompt: "A", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", {
      original_input: { request: "build" },
      approved_plan: "Run the relevant tests.",
      plan_requested_permissions: [{ tool: "Bash", prompt: "run tests" }]
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; tool?: string });
    assert.equal(events.some((event) => event.type === "permission_requested"), false);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool === "Bash"), true);
  });

  it("keeps Plan Mode requested Bash prompt permissions after workflow resume", async () => {
    const runRoot = `.tmp/plan-requested-permission-resume-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: JSON.stringify({ status: "success", summary: "a done", handoff: { instruction: "continue" } }) };
        if (calls === 2) return { content: JSON.stringify({ status: "failure", summary: "need tests", feedback: { defects: ["missing tests"], change_requests: [] }, handoff: { instruction: "run tests" } }) };
        if (calls === 3) {
          return {
            content: "checking test runner",
            tool_calls: [{ id: "call-bash", name: "Bash", input: { command: "node --test --help", timeout_ms: 30000 } }]
          };
        }
        return { content: JSON.stringify({ status: "success", summary: "b done", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
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

    assert.equal(failed.status, "pending");
    assert.deepEqual(failed.plan_requested_permission_rules, ["Bash(prompt:run tests)"]);

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "run tests now" });

    assert.equal(resumed.status, "completed");
    assert.equal(calls, 4);
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

  it("persists a run-level permission mode override", async () => {
    const engine = new WorkflowEngine({ providerFactory: () => new FakeProvider(), cwd: process.cwd(), runRoot: `.tmp/run-permission-mode-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { permissionMode: "bypassPermissions" });

    assert.equal(result.status, "completed");
    assert.equal(result.run_permission_mode, "bypassPermissions");
  });

  it("turns clear-context approved plans into a tui-code style implementation request", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/clear-context-plan-${Date.now()}` });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default" as const, permission_mode: "default" as const }], edges: [] } }
    };

    await engine.run(config, "flow", {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it.",
      plan_file_path: ".session/plans/session-1.md",
      plan_approval_feedback: "Also update README."
    }, { permissionMode: "acceptEdits", clearContext: true });

    const firstUserText = nonRuntimeUserText(requests[0]);

    assert.match(firstUserText, /"request": "Implement the following plan:\\n\\n# Plan\\nBuild it\.\\n\\nUser feedback on this plan: Also update README\."/);
    assert.match(firstUserText, /"clear_context": true/);
    assert.match(firstUserText, /"approved_plan": "# Plan\\nBuild it\."/);

    requests.length = 0;
    await engine.run(config, "flow", {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it."
    }, { permissionMode: "acceptEdits" });

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
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "Ready empty exit.", [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: false });

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; input?: unknown });
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

  it("uses run-level bypass permissions for workflow tool execution", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: "checking", tool_calls: [{ id: "tool-1", name: "Bash", input: { command: "echo workflow-bypass" } }] };
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/run-bypass-${Date.now()}` });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { permissionMode: "bypassPermissions" });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
  });

  it("uses run-level auto permissions for workflow edit tools", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const runRoot = `.tmp/run-auto-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) return { content: "writing artifact", tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "auto.md", content: "# Auto\nDone.", description: "Auto artifact" } }] };
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }], edges: [] } }
    }, "flow", { request: "x" }, { permissionMode: "auto" });

    assert.equal(result.status, "completed");
    assert.equal(result.run_permission_mode, "auto");
    assert.equal(calls, 2);
    const firstSystem = requests[0]?.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n") ?? "";
    assert.match(firstSystem, /ATTACHMENT auto_mode/);
    assert.match(firstSystem, /## Auto Mode Active/);

    const runId = await latestRunId(runRoot);
    const events = (await readFile(join(runRoot, runId, "events.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; tool?: string });
    assert.equal(events.some((event) => event.type === "permission_requested"), false);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool === "ArtifactWrite"), true);
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

  it("resumes a failed node with user rework", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ status: "failure", summary: "implementation rejected", feedback: { defects: ["missing tests"], change_requests: [] }, handoff: { instruction: "fix" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "rework accepted", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/failure-rework-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
      },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
    };

    const failed = await engine.run(config, "flow", { request: "x" });
    assert.equal(failed.status, "pending");
    assert.equal(failed.attempts.at(-1)?.status, "failure");

    const runId = await latestRunId(runRoot);
    const resumed = await engine.resume(config, "flow", runId, { answer: "add unit tests and retry" });

    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 2);

    const devMessages = requests[1]?.messages.filter((m) => m.role === "user");
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
  const runs = await readdir(root, { withFileTypes: true });
  return runs.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().at(-1) ?? "";
}

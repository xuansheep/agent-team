import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNode } from "../../src/harness/runtime.js";
import { RunStore } from "../../src/storage/runStore.js";
import { createLocalToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import { ModelProvider, ModelRequestContext } from "../../src/providers/types.js";

describe("runNode interactive permissions", () => {
  it("asks for permission and executes tool after allow_once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    tools.add({
      name: "Bash",
      description: "fake bash",
      input_schema: {},
      async execute() {
        return { output: "ok", exit_code: 0 };
      }
    });

    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { content: "我先运行测试确认当前状态。", tool_calls: [{ id: "tool-1", name: "Bash", input: { command: "npm test" } }] };
        }
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: ["Bash(npm test)"], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      interaction: {
        async requestPermission(request) {
          assert.equal(request.tool, "Bash");
          assert.equal(request.specifier, "npm test");
          return "allow_once";
        }
      }
    });

    assert.equal(result.status, "success");
    const eventsText = await readFile(join(root, run.runId, "events.ndjson"), "utf8");
    assert.match(eventsText, /permission_requested/);
    assert.match(eventsText, /permission_resolved/);
    assert.match(eventsText, /tool_completed/);
  });

  it("emits artifact events and returns deliverables for artifact tool output", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-artifact-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = createLocalToolRegistry();
    let calls = 0;

    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "report.md", content: "# Report\nDone.", description: "User report" } }] };
        }
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["ArtifactWrite"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    });

    assert.deepEqual(result.deliverables, [{ artifact_id: "dev/report.md", description: "User report" }]);
    assert.equal(await readFile(join(root, run.runId, "artifacts", "dev", "report.md"), "utf8"), "# Report\nDone.");
    const eventsText = await readFile(join(root, run.runId, "events.ndjson"), "utf8");
    assert.match(eventsText, /artifact_created/);
    assert.match(eventsText, /dev\/report\.md/);
  });

  it("accepts SubmitNodeResult tool calls as the final node result", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-submit-result-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let requestedPermission = false;

    const provider: ModelProvider = {
      async generate() {
        return {
          tool_calls: [{
            id: "tool-1",
            name: "SubmitNodeResult",
            input: {
              status: "success",
              summary: "done",
              document: "",
              deliverables: [],
              feedback: { defects: [], change_requests: [] },
              questions: [],
              handoff: { instruction: "next", must_follow: [], known_risks: [], open_questions: [] }
            }
          }]
        };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: ["SubmitNodeResult"], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      interaction: {
        async requestPermission() {
          requestedPermission = true;
          return "allow_once";
        }
      }
    });

    assert.equal(result.status, "success");
    assert.equal(result.handoff.instruction, "next");
    assert.equal(requestedPermission, false);
  });

  it("passes stable short prompt cache keys in model request context", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-context-"));
    const store = new RunStore(root);
    const tools = new ToolRegistry();
    const runId = "2026-06-25T10-53-35-371Z-859a43fb-6df8-4959-b37a-97fee9ac57eb";
    const contexts: ModelRequestContext[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        assert.ok(request.context);
        contexts.push(request.context);
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const options = {
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    };

    await runNode(options);
    await runNode(options);

    assert.equal(contexts[0]?.threadId, `${runId}:dev`);
    assert.equal(contexts[0]?.promptCacheKey.length, 64);
    assert.match(contexts[0]?.promptCacheKey ?? "", /^[0-9a-f]{64}$/);
    assert.equal(contexts[0]?.promptCacheKey, contexts[1]?.promptCacheKey);
  });

  it("sends assistant tool calls before tool outputs on the follow-up model request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-tool-chain-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    tools.add({
      name: "LS",
      description: "fake ls",
      input_schema: {},
      async execute() {
        return { output: "package.json", exit_code: 0 };
      }
    });

    const requests: Array<{ messages: unknown[] }> = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push({ messages: request.messages });
        if (requests.length === 1) {
          return { content: "我先列出目录确认文件。", tool_calls: [{ id: "tool-1", name: "LS", input: { path: "." } }] };
        }
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["LS(.)"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    });

    assert.equal(result.status, "success");
    const followUp = requests[1]?.messages.slice(-2);
    assert.deepEqual(followUp, [
      { role: "assistant", content: "我先列出目录确认文件。", tool_calls: [{ id: "tool-1", name: "LS", input: { path: "." } }] },
      { role: "tool", tool_call_id: "tool-1", content: JSON.stringify({ output: "package.json", exit_code: 0 }) }
    ]);
  });

  it("asks the model to repair an invalid final NodeResult once without increasing node attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-repair-result-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    const requests: Array<{ messages: unknown[]; attempt?: number }> = [];
    let calls = 0;
    const invalid = JSON.stringify({ status: "needs_user_input", summary: "need input", document: "", deliverables: [], feedback: { defects: [], change_requests: [] }, questions: [], handoff: { instruction: "", must_follow: [], known_risks: [], open_questions: [] } });

    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push({ messages: request.messages, attempt: request.context?.attempt });
        if (calls === 1) return { content: invalid };
        return { content: JSON.stringify({ status: "success", summary: "repaired", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "product", role: "product", provider: "default", permission_mode: "default" },
      systemPrompt: "Product",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary, "repaired");
    assert.equal(calls, 2);
    assert.deepEqual(requests.map((request) => request.attempt), [1, 1]);
    assert.match(JSON.stringify(requests[1]?.messages), /Return exactly one valid NodeResult JSON object/);
  });
});

describe("runNode streaming", () => {
  it("stores model stream deltas and still returns the final node result", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-stream-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    const provider: ModelProvider = {
      async generate() {
        throw new Error("generate should not be used when stream is available");
      },
      async stream(request, onEvent) {
        assert.ok(request.response_schema);
        const system = request.messages.find((message) => message.role === "system")?.content;
        assert.match(String(system), /Before calling tools/);
        assert.match(String(system), /final NodeResult/);
        onEvent({ type: "content_delta", text: "{\"status\":\"success\"," });
        onEvent({ type: "content_delta", text: "\"summary\":\"done\"}" });
        return { content: "{\"status\":\"success\",\"summary\":\"done\"}" };
      }
    };

    const result = await runNode({
      node: { id: "product", role: "product", provider: "default", permission_mode: "default" },
      systemPrompt: "Product",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    });

    assert.equal(result.status, "success");
    const eventsText = await readFile(join(root, run.runId, "events.ndjson"), "utf8");
    assert.match(eventsText, /model_stream_delta/);
    assert.match(eventsText, /summary/);
  });

  it("stores model thinking deltas separately from response deltas", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-thinking-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    const provider: ModelProvider = {
      async generate() {
        throw new Error("generate should not be used when stream is available");
      },
      async stream(_request, onEvent) {
        onEvent({ type: "thinking_delta", text: "Checked constraints." });
        onEvent({ type: "content_delta", text: "{\"status\":\"success\"}" });
        return { thinking: "Checked constraints.", content: "{\"status\":\"success\"}" };
      }
    };

    const result = await runNode({
      node: { id: "product", role: "product", provider: "default", permission_mode: "default" },
      systemPrompt: "Product",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    });

    assert.equal(result.status, "success");
    const eventsText = await readFile(join(root, run.runId, "events.ndjson"), "utf8");
    assert.match(eventsText, /model_thinking_delta/);
    assert.match(eventsText, /model_stream_delta/);
  });
});

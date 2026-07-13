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
  it("recovers a completed tool result from the event ledger without executing it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-recover-tool-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    await store.appendEvent(run.runId, { type: "tool_invoked", node_id: "dev", attempt: 1, activation: 1, tool_call_id: "tool-old", tool: "WriteOnce", input: { value: "x" } });
    await store.appendEvent(run.runId, { type: "tool_completed", node_id: "dev", attempt: 1, activation: 1, tool_call_id: "tool-old", tool: "WriteOnce", result: { output: "saved", exit_code: 0 } });
    let executions = 0;
    const tools = new ToolRegistry();
    tools.add({
      name: "WriteOnce",
      description: "non-idempotent test tool",
      input_schema: {},
      isReadOnly: () => false,
      async execute() {
        executions += 1;
        return { output: "duplicate" };
      }
    });
    const provider: ModelProvider = {
      async generate(request) {
        const recovered = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "tool-old");
        assert.match(String(recovered?.content), /saved/);
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["WriteOnce"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 1,
      dialogueMessages: [{ role: "assistant", content: "Saving.", tool_calls: [{ id: "tool-old", name: "WriteOnce", input: { value: "x" } }] }]
    });

    assert.equal(result.direction, "forward");
    assert.equal(executions, 0);
  });

  it("refuses to replay an equivalent non-read-only tool call with an unknown outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-in-doubt-tool-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    await store.appendEvent(run.runId, { type: "tool_invoked", node_id: "dev", attempt: 1, activation: 1, tool_call_id: "tool-old", tool: "WriteOnce", input: { value: "x" } });
    let executions = 0;
    const tools = new ToolRegistry();
    tools.add({
      name: "WriteOnce",
      description: "non-idempotent test tool",
      input_schema: {},
      isReadOnly: () => false,
      async execute() {
        executions += 1;
        return { output: "duplicate" };
      }
    });
    const provider: ModelProvider = {
      async generate() {
        return { content: "I will retry the write.", tool_calls: [{ id: "tool-new", name: "WriteOnce", input: { value: "x" } }] };
      }
    };

    await assert.rejects(() => runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["WriteOnce"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 1,
      dialogueMessages: [{ role: "assistant", content: "Saving.", tool_calls: [{ id: "tool-old", name: "WriteOnce", input: { value: "x" } }] }]
    }), /Refusing to repeat non-read-only tool/);
    assert.equal(executions, 0);
  });

  it("injects long tool prompts into workflow node system messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-tool-prompt-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    tools.add({
      name: "PromptedTool",
      description: "Short provider description",
      prompt: "Long workflow-facing tool prompt.",
      input_schema: {},
      async execute() {
        return { output: "" };
      }
    });
    let capturedSystem = "";
    let capturedDescription = "";
    const provider: ModelProvider = {
      async generate(request) {
        capturedSystem = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
        capturedDescription = request.tools.find((tool) => tool.name === "PromptedTool")?.description ?? "";
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
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

    assert.equal(result.direction, "forward");
    assert.equal(capturedDescription, "Short provider description");
    assert.match(capturedSystem, /ATTACHMENT tool_prompts/);
    assert.match(capturedSystem, /### PromptedTool/);
    assert.match(capturedSystem, /Long workflow-facing tool prompt/);
    assert.doesNotMatch(capturedSystem, /Short provider description/);
  });

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
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
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
    assert.equal(result.direction, "forward");
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
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
          return { content: "我先写入报告产物。", tool_calls: [{ id: "tool-1", name: "ArtifactWrite", input: { name: "report.md", content: "# Report\nDone.", description: "User report" } }] };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
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
    assert.deepEqual(result.deliverables, [{ artifact_id: "dev/report.md@r1", description: "User report" }]);
    assert.equal(await readFile(join(run.runDir, "artifacts", "dev", "r0001-report.md"), "utf8"), "# Report\nDone.");
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
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
              direction: "forward",
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
    assert.equal(result.direction, "forward");
    assert.equal(result.handoff.instruction, "next");
    assert.equal(requestedPermission, false);
  });
  it("passes stable short prompt cache keys in model request context", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-context-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    const runId = run.runId;
    const contexts: ModelRequestContext[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        assert.ok(request.context);
        contexts.push(request.context);
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
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
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
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
    assert.equal(result.direction, "forward");
    const followUp = requests[1]?.messages.slice(-2);
    assert.deepEqual(followUp, [
      { role: "assistant", content: "我先列出目录确认文件。", tool_calls: [{ id: "tool-1", name: "LS", input: { path: "." } }] },
      { role: "tool", tool_call_id: "tool-1", content: JSON.stringify({ output: "package.json", exit_code: 0 }) }
    ]);
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
    assert.match(eventsText, /model_stream_delta/);
    assert.match(eventsText, /我先列出目录确认文件。/);
  });
  it("repairs empty assistant content before tool-call turns so TUI gets a real preamble", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-empty-tool-preamble-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let executions = 0;
    tools.add({
      name: "LS",
      description: "fake ls",
      input_schema: {},
      async execute() {
        executions += 1;
        return { output: "package.json", exit_code: 0 };
      }
    });
    const requests: Array<{ messages: unknown[] }> = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push({ messages: request.messages });
        if (requests.length === 1) {
          return { tool_calls: [{ id: "tool-1", name: "LS", input: { path: "." } }] };
        }
        if (requests.length === 2) {
          return { content: "我先列出目录确认项目结构。", tool_calls: [{ id: "tool-2", name: "LS", input: { path: "." } }] };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
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
    assert.equal(result.direction, "forward");
    assert.equal(executions, 1);
    assert.match(JSON.stringify(requests[1]?.messages), /tool-call turn did not include a user-visible natural-language preamble/);
    const followUp = requests[2]?.messages.slice(-2);
    assert.deepEqual(followUp, [
      { role: "assistant", content: "我先列出目录确认项目结构。", tool_calls: [{ id: "tool-2", name: "LS", input: { path: "." } }] },
      { role: "tool", tool_call_id: "tool-2", content: JSON.stringify({ output: "package.json", exit_code: 0 }) }
    ]);
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
    assert.match(eventsText, /我先列出目录确认项目结构。/);
  });
  it("repairs raw NodeResult text before tool-call turns so TUI gets a real preamble", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-strip-tool-json-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let executions = 0;
    tools.add({
      name: "LS",
      description: "fake ls",
      input_schema: {},
      async execute() {
        executions += 1;
        return { output: "package.json", exit_code: 0 };
      }
    });
    const requests: Array<{ messages: unknown[]; system?: unknown }> = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push({ messages: request.messages, system: request.messages.find((message) => message.role === "system")?.content });
        if (requests.length === 1) {
          return { content: `{"deliverables":[],"document":"","status`, tool_calls: [{ id: "tool-1", name: "LS", input: { path: "." } }] };
        }
        if (requests.length === 2) {
          return { content: "我先列出目录确认项目结构。", tool_calls: [{ id: "tool-2", name: "LS", input: { path: "." } }] };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
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
    assert.equal(result.direction, "forward");
    assert.equal(executions, 1);
    assert.match(JSON.stringify(requests[1]?.messages), /tool-call turn did not include a user-visible natural-language preamble/);
    const followUp = requests[2]?.messages.slice(-2);
    assert.deepEqual(followUp, [
      { role: "assistant", content: "我先列出目录确认项目结构。", tool_calls: [{ id: "tool-2", name: "LS", input: { path: "." } }] },
      { role: "tool", tool_call_id: "tool-2", content: JSON.stringify({ output: "package.json", exit_code: 0 }) }
    ]);
    assert.doesNotMatch(JSON.stringify(followUp), /deliverables|document|status/);
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
    assert.match(eventsText, /我先列出目录确认项目结构。/);
  });
  it("asks the model to repair an invalid final NodeResult once without increasing node attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-repair-result-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    const requests: Array<{ messages: unknown[]; attempt?: number }> = [];
    let calls = 0;
    const invalid = JSON.stringify({ direction: "sideways", summary: "need input", document: "", deliverables: [], feedback: { defects: [], change_requests: [] }, questions: [], handoff: { instruction: "", must_follow: [], known_risks: [], open_questions: [] } });
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push({ messages: request.messages, attempt: request.context?.attempt });
        if (calls === 1) return { content: invalid };
        return { content: JSON.stringify({ direction: "forward", summary: "repaired", handoff: { instruction: "next" } }) };
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
    assert.equal(result.direction, "forward");
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
        assert.equal(request.response_schema, undefined);
        assert.ok(request.tools.some((tool) => tool.name === "SubmitNodeResult"));
        const system = request.messages.find((message) => message.role === "system")?.content;
        assert.match(String(system), /Preamble messages/);
        assert.match(String(system), /Before making tool calls, send a brief preamble/);
        assert.match(String(system), /I\'ve explored the repo; now checking the API route definitions/);
        assert.match(String(system), /Before calling tools/);
        assert.match(String(system), /Build on prior context/);
        assert.match(String(system), /Logically group related actions/);
        assert.match(String(system), /When SubmitNodeResult is available/);
        assert.match(String(system), /assistant content field must contain the preamble/);
        assert.match(String(system), /Do not put NodeResult JSON in assistant content/);
        assert.match(String(system), /final NodeResult/);
        onEvent({ type: "content_delta", text: "{\"direction\":\"forward\"," });
        onEvent({ type: "content_delta", text: "\"summary\":\"done\"}" });
        return { content: "{\"direction\":\"forward\",\"summary\":\"done\"}" };
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
    assert.equal(result.direction, "forward");
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
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
        onEvent({ type: "content_delta", text: "{\"direction\":\"forward\"}" });
        return { thinking: "Checked constraints.", content: "{\"direction\":\"forward\"}" };
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
    assert.equal(result.direction, "forward");
    const eventsText = await readFile(join(run.runDir, "events.ndjson"), "utf8");
    assert.match(eventsText, /model_thinking_delta/);
    assert.match(eventsText, /model_stream_delta/);
  });
});

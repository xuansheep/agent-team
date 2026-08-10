import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNode } from "../../src/harness/runtime.js";
import { toolPolicyFailureResult } from "../../src/tools/errors.js";
import { RunStore } from "../../src/storage/runStore.js";
import { createLocalToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import { ModelMessage, ModelProvider, ModelRequestContext } from "../../src/providers/types.js";
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

  it("recalibrates node context from usage and estimates messages between responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-context-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    tools.add({
      name: "Echo",
      description: "returns test output",
      input_schema: {},
      isReadOnly: () => true,
      async execute() {
        return { output: "abcdefgh".repeat(10) };
      }
    });
    let requests = 0;
    const provider: ModelProvider = {
      async generate() {
        requests += 1;
        if (requests === 1) {
          return {
            content: "Running Echo.",
            tool_calls: [{ id: "tool-1", name: "Echo", input: {} }],
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
          };
        }
        return {
          content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }),
          usage: { inputTokens: 180, outputTokens: 20, totalTokens: 200 }
        };
      }
    };

    await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["Echo"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 1
    });

    const contexts = (await store.loadEvents(run.runId)).filter((event) => event.type === "node_context_updated");
    assert.ok(contexts.some((event) => event.context_tokens > 120));
    assert.equal(contexts.at(-1)?.context_tokens, 200);
    assert.equal((await store.latestNodeContext(run.runId, "dev", 1))?.context_tokens, 200);
  });

  it("republishes restored context before a continued node activation sends its first request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-restored-context-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    await store.appendEvent(run.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      context_tokens: 100,
      dialogue_message_count: 1
    });
    let restoredBeforeRequest = false;
    const provider: ModelProvider = {
      async generate() {
        const restored = await store.latestNodeContext(run.runId, "dev", 1);
        restoredBeforeRequest = restored?.activation === 2 && restored.context_tokens === 100;
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools: new ToolRegistry(),
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 2,
      dialogueMessages: [{ role: "user", content: "continue" }]
    });

    assert.equal(restoredBeforeRequest, true);
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

  it("keeps built-in safety denials fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-built-in-deny-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let executions = 0;
    tools.add({
      name: "ExitPlanMode",
      description: "fake exit plan mode",
      input_schema: {},
      async execute() {
        executions += 1;
        return { output: "exited" };
      }
    });
    const provider: ModelProvider = {
      async generate() {
        return { content: "exit", tool_calls: [{ id: "exit-denied", name: "ExitPlanMode", input: {} }] };
      }
    };

    await assert.rejects(() => runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["ExitPlanMode"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    }), /Permission denied for ExitPlanMode: You are not in plan mode/);

    assert.equal(executions, 0);
    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) => event.type === "tool_failed" && event.tool_call_id === "exit-denied"), true);
    assert.equal(events.some((event) => event.type === "tool_invoked" && event.tool_call_id === "exit-denied"), false);
  });

  it("records configured shell denials and safely continues the node", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-deny-continue-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let shellExecutions = 0;
    let writeExecutions = 0;
    let readExecutions = 0;
    tools.add({
      name: "Bash",
      description: "fake bash",
      input_schema: {},
      isReadOnly: () => false,
      async execute() {
        shellExecutions += 1;
        return { output: "removed" };
      }
    });
    tools.add({
      name: "WriteProbe",
      description: "fake write",
      input_schema: {},
      isReadOnly: () => false,
      async execute() {
        writeExecutions += 1;
        return { output: "written" };
      }
    });
    tools.add({
      name: "ReadProbe",
      description: "fake read",
      input_schema: {},
      isReadOnly: () => true,
      async execute() {
        readExecutions += 1;
        return { output: "read" };
      }
    });
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return {
            content: "I will clean up and inspect.",
            tool_calls: [
              { id: "shell-denied", name: "Bash", input: { command: "rm -rf dist" } },
              { id: "write-cancelled", name: "WriteProbe", input: {} },
              { id: "read-allowed", name: "ReadProbe", input: {} }
            ]
          };
        }
        const denial = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "shell-denied");
        assert.match(String(denial?.content), /Permission denied for Bash: Bash\(rm \*\)/);
        return { content: JSON.stringify({ direction: "forward", summary: "replanned", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "fullAccess" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["Bash", "WriteProbe", "ReadProbe"], ask: [], deny: ["Bash(rm *)"] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1
    });

    assert.equal(result.direction, "forward");
    assert.equal(calls, 2);
    assert.equal(shellExecutions, 0);
    assert.equal(writeExecutions, 0);
    assert.equal(readExecutions, 1);
    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) => event.type === "tool_failed" && event.tool_call_id === "shell-denied"), true);
    assert.equal(events.some((event) => event.type === "tool_invoked" && event.tool_call_id === "shell-denied"), false);
    assert.equal(events.some((event) => event.type === "tool_failed" && event.tool_call_id === "write-cancelled" && event.failure_category === "tool.cancelled_after_shell_failure"), true);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool_call_id === "read-allowed"), true);
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
    let persistedDialogue: unknown[] = [];
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
      },
      onDialogueMessages(messages) {
        persistedDialogue = messages;
      }
    });
    assert.equal(result.direction, "forward");
    assert.equal(result.handoff.instruction, "next");
    assert.equal(requestedPermission, false);
    assert.deepEqual(persistedDialogue.slice(-2), [
      {
        role: "assistant",
        content: "",
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
      },
      { role: "tool", tool_call_id: "tool-1", content: JSON.stringify({ status: "submitted" }) }
    ]);
  });

  it("repairs an unmatched legacy SubmitNodeResult call before resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-recover-submit-result-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    const submittedCall = {
      id: "tool-old-submit",
      name: "SubmitNodeResult",
      input: {
        direction: "forward",
        summary: "previous activation completed",
        document: "",
        deliverables: [],
        feedback: { defects: [], change_requests: [] },
        questions: [],
        handoff: { instruction: "continue", must_follow: [], known_risks: [], open_questions: [] }
      }
    };
    const provider: ModelProvider = {
      async generate(request) {
        const assistantIndex = request.messages.findIndex((message) =>
          message.role === "assistant" && message.tool_calls?.some((call) => call.id === submittedCall.id)
        );
        assert.notEqual(assistantIndex, -1);
        assert.deepEqual(request.messages.slice(assistantIndex, assistantIndex + 3), [
          { role: "assistant", content: "", tool_calls: [submittedCall] },
          { role: "tool", tool_call_id: submittedCall.id, content: JSON.stringify({ status: "submitted" }) },
          { role: "user", content: "Rework the accessibility defect." }
        ]);
        return { content: JSON.stringify({ direction: "forward", summary: "fixed", handoff: { instruction: "next" } }) };
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
      attempt: 1,
      activation: 2,
      dialogueMessages: [
        { role: "assistant", content: "", tool_calls: [submittedCall] },
        { role: "user", content: "Rework the accessibility defect." }
      ]
    });

    assert.equal(result.direction, "forward");
    assert.equal(result.summary, "fixed");
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
  it("injects queued guidance before executing tool calls from the sampled response", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-input-before-tool-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let executions = 0;
    tools.add({
      name: "Echo",
      description: "fake echo",
      input_schema: {},
      async execute() {
        executions += 1;
        return { output: "stale" };
      }
    });
    let calls = 0;
    let pending = true;
    const requests: ModelMessage[][] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request.messages);
        if (calls === 1) {
          return {
            content: "I will inspect the current state.",
            tool_calls: [{ id: "tool-abandoned", name: "Echo", input: { value: "stale" } }]
          };
        }
        assert.equal(request.messages.at(-1)?.role, "user");
        assert.equal(request.messages.at(-1)?.content, "updated guidance");
        assert.equal(request.messages.some((message) => message.tool_calls?.some((call) => call.id === "tool-abandoned")), false);
        return { content: JSON.stringify({ direction: "forward", summary: "updated", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["Echo"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      drainPendingUserInputs: () => {
        if (calls !== 1 || !pending) return [];
        pending = false;
        return [{ id: "input-before-tool", input: { role: "user", content: "updated guidance" } }];
      }
    });

    const events = await store.loadEvents(run.runId);
    assert.equal(result.summary, "updated");
    assert.equal(calls, 2);
    assert.equal(requests.length, 2);
    assert.equal(executions, 0);
    assert.deepEqual(
      events.filter((event) => event.type === "user_input_injected").map((event) => event.input_id),
      ["input-before-tool"]
    );
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
  it("repairs a thinking-only empty response once without interrupting the node", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-repair-empty-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const requests: ModelMessage[][] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request.messages);
        if (requests.length === 1) {
          return { thinking: "I know what to do.", stopReason: "stop" };
        }
        return {
          content: JSON.stringify({
            direction: "forward",
            summary: "continued after repair",
            handoff: { instruction: "next" }
          })
        };
      }
    };

    const result = await runNode({
      node: { id: "tester", role: "tester", provider: "default", permission_mode: "default" },
      systemPrompt: "Tester",
      model: "gpt-test",
      provider,
      tools: new ToolRegistry(),
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "verify" },
      attempt: 1,
      activation: 2
    });

    assert.equal(result.summary, "continued after repair");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /thinking-only or empty response/);
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
  it("blocks a repeated shell strategy and cancels later writes while allowing reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-shell-strategy-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let shellExecutions = 0;
    let writeExecutions = 0;
    let readExecutions = 0;
    tools.add({
      name: "Bash",
      description: "fake failing bash",
      input_schema: {},
      isReadOnly: () => false,
      async execute() {
        shellExecutions += 1;
        return toolPolicyFailureResult("git.not_repository", "fatal: not a git repository", "bash");
      }
    });
    tools.add({
      name: "WriteProbe",
      description: "fake write",
      input_schema: {},
      isReadOnly: () => false,
      async execute() {
        writeExecutions += 1;
        return { output: "written" };
      }
    });
    tools.add({
      name: "ReadProbe",
      description: "fake read",
      input_schema: {},
      isReadOnly: () => true,
      async execute() {
        readExecutions += 1;
        return { output: "read" };
      }
    });
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls <= 2) {
          return {
            content: "I will inspect the repository.",
            tool_calls: [{ id: `shell-${calls}`, name: "Bash", input: { command: "git status" } }]
          };
        }
        if (calls === 3) {
          return {
            content: "I will retry and then update the file.",
            tool_calls: [
              { id: "shell-3", name: "Bash", input: { command: "git status" } },
              { id: "write-1", name: "WriteProbe", input: {} },
              { id: "read-1", name: "ReadProbe", input: {} }
            ]
          };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "replanned", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["Bash", "WriteProbe", "ReadProbe"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 1
    });

    assert.equal(result.direction, "forward");
    assert.equal(shellExecutions, 2);
    assert.equal(writeExecutions, 0);
    assert.equal(readExecutions, 1);
    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) =>
      event.type === "tool_failed"
      && event.tool_call_id === "shell-3"
      && event.failure_category === "tool.strategy_blocked"
    ), true);
    assert.equal(events.some((event) =>
      event.type === "tool_failed"
      && event.tool_call_id === "write-1"
      && event.failure_category === "tool.cancelled_after_shell_failure"
    ), true);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool_call_id === "read-1"), true);
  });

  it("propagates abort to an active tool without recording a normal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-abort-tool-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    tools.add({
      name: "BlockingTool",
      description: "blocking test tool",
      input_schema: {},
      async execute(_input, context) {
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(context.abortSignal?.reason);
          if (context.abortSignal?.aborted) abort();
          else context.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      }
    });
    const provider: ModelProvider = {
      async generate() {
        return { content: "I am starting the blocking tool.", tool_calls: [{ id: "tool-abort", name: "BlockingTool", input: {} }] };
      }
    };
    const controller = new AbortController();
    const execution = runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: ["BlockingTool"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      abortSignal: controller.signal
    });

    await started;
    controller.abort();
    await assert.rejects(execution, (error: unknown) => error instanceof Error && error.name === "AbortError");

    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) => event.type === "tool_invoked" && event.tool_call_id === "tool-abort"), true);
    assert.equal(events.some((event) => event.type === "tool_completed" && event.tool_call_id === "tool-abort"), false);
    assert.equal(events.some((event) => event.type === "tool_failed" && event.tool_call_id === "tool-abort"), false);
  });
});
describe("runNode provider failures", () => {
  it("does not persist AbortError as an assistant failure message", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-abort-error-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";
    const provider: ModelProvider = {
      async generate() {
        throw abortError;
      }
    };
    let dialogueMessages: ModelMessage[] = [];

    await assert.rejects(() => runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools: new ToolRegistry(),
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      onDialogueMessages(messages) {
        dialogueMessages = messages;
      }
    }), (error: unknown) => error instanceof Error && error.name === "AbortError");

    assert.equal(dialogueMessages.some((message) => message.role === "assistant" && message.is_error), false);
  });
});

describe("runNode AskUserQuestion", () => {
  it("returns a waiting result without sampling another model turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-ask-user"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = createLocalToolRegistry();
    let calls = 0;
    let waitingUserResult: { status: "waiting_user"; toolCallId: string; questions: unknown[] } | undefined;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return {
          content: "我需要先确认一个选择。",
          tool_calls: [{
            id: "ask-1",
            name: "AskUserQuestion",
            input: {
              questions: [{
                header: "方案",
                question: "选择哪套方案？",
                options: [
                  { label: "默认方案", description: "使用默认配置。" },
                  { label: "自定义方案", description: "手动指定配置。" }
                ]
              }]
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
      permissions: { allow: ["AskUserQuestion"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 1,
      onUserInputRequested: (request) => {
        waitingUserResult = request;
      }
    });

    assert.equal(waitingUserResult?.status, "waiting_user");
    assert.equal(waitingUserResult?.toolCallId, "ask-1");
    assert.equal((waitingUserResult?.questions[0] as { id?: string } | undefined)?.id, "方案");
    assert.equal(calls, 1);

    const events = await store.loadEvents(run.runId);
    assert.equal(events.filter((event) => event.type === "model_response_recorded").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_completed").length, 1);
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
      attempt: 1,
      activation: 2
    });
    assert.equal(result.direction, "forward");
    const events = await store.loadEvents(run.runId);
    const deltas = events.filter((event) => event.type === "model_stream_delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0]?.text, "{\"direction\":\"forward\",\"summary\":\"done\"}");
    assert.equal(deltas[0]?.activation, 2);
  });
  it("flushes the final stream fragment before surfacing provider errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-stream-error-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const provider: ModelProvider = {
      async generate() {
        throw new Error("generate should not be used when stream is available");
      },
      async stream(_request, onEvent) {
        onEvent({ type: "content_delta", text: "tail-fragment" });
        throw new Error("stream failed");
      }
    };

    await assert.rejects(() => runNode({
      node: { id: "product", role: "product", provider: "default", permission_mode: "default" },
      systemPrompt: "Product",
      model: "gpt-test",
      provider,
      tools: new ToolRegistry(),
      permissions: { allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      activation: 3
    }), /stream failed/);

    const delta = (await store.loadEvents(run.runId)).find((event) => event.type === "model_stream_delta");
    assert.equal(delta?.text, "tail-fragment");
    assert.equal(delta?.activation, 3);
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

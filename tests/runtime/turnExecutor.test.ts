import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeTurnExecutor } from "../../src/runtime/turnExecutor.js";
import { ModelProvider } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Tool } from "../../src/tools/types.js";

describe("RuntimeTurnExecutor", () => {
  it("returns completed for a provider response without tools and preserves the assistant message", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: "ready" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(result.messages.at(-1)?.content, "ready");
  });

  it("executes tool calls and appends tool results before the final assistant message", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return { content: "checking", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
        }
        assert.equal(request.messages.at(-1)?.role, "tool");
        assert.match(String(request.messages.at(-1)?.content), /ok/);
        return { content: "done" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(echoTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "use a tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: ["Echo"], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(result.messages.at(-1)?.content, "done");
  });

  it("runs a plan mode conversation turn without a workflow runner", async () => {
    let workflowRuns = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "Plan draft only." };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before execution" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-plan"
    });

    assert.equal(result.status, "completed");
    assert.equal(result.messages.at(-1)?.content, "Plan draft only.");
    assert.equal(workflowRuns, 0);
  });

  it("runs concurrency-safe tool calls in parallel through the runtime executor", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "checking",
            tool_calls: [
              { id: "call-1", name: "ReadOne", input: {} },
              { id: "call-2", name: "ReadTwo", input: {} },
              { id: "call-3", name: "ReadThree", input: {} }
            ]
          };
        }
        return { content: "done" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(delayedReadTool("ReadOne"));
    tools.add(delayedReadTool("ReadTwo"));
    tools.add(delayedReadTool("ReadThree"));

    const startedAt = Date.now();
    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "use tools" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: ["ReadOne", "ReadTwo", "ReadThree"], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.ok(Date.now() - startedAt < 180);
    assert.equal(result.messages.filter((message) => message.role === "tool").length, 3);
  });

  it("returns waiting_permission before executing tools that require approval", async () => {
    let executions = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "checking", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add({
      ...echoTool,
      async execute(input, context) {
        executions += 1;
        return echoTool.execute(input, context);
      }
    });

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "use a tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: [], ask: ["Echo"], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-ask"
    });

    assert.equal(result.status, "waiting_permission");
    assert.equal(executions, 0);
  });

  it("emits model usage events for audit and session metadata sinks", async () => {
    const events: unknown[] = [];
    const provider: ModelProvider = {
      async generate() {
        return { content: "ready", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, stopReason: "stop" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-usage",
      eventSink: (event) => { events.push(event); }
    });

    assert.deepEqual(events.find((event) => (event as { type?: string }).type === "runtime_model_usage"), {
      type: "runtime_model_usage",
      session_id: "session-usage",
      run_id: undefined,
      model: "test-model",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      stop_reason: "stop"
    });
  });

  it("rejects normal write tools in plan mode before execution", async () => {
    let executions = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "writing", tool_calls: [{ id: "call-1", name: "Write", input: { file_path: "src/index.ts", content: "x" } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(writeTool(() => { executions += 1; }));

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan only" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan"
    });

    assert.equal(result.status, "failed");
    assert.match(result.error, /Plan Mode/);
    assert.equal(executions, 0);
  });

});

const echoTool: Tool = {
  name: "Echo",
  description: "Returns the provided value.",
  input_schema: {},
  async execute(input) {
    return { output: String((input as { value?: unknown }).value ?? "") };
  }
};

function delayedReadTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { output: name };
    }
  };
}

function writeTool(onExecute: () => void): Tool {
  return {
    name: "Write",
    description: "Write a file.",
    input_schema: {},
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    writesPlanFile(input) {
      return String((input as { file_path?: unknown }).file_path ?? "").startsWith(".session/plans/");
    },
    async execute() {
      onExecute();
      return { output: "wrote" };
    }
  };
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRuntime } from "../../src/hooks/runtime.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-hooks-"));
}

describe("hook runtime", () => {
  it("runs command hooks and applies PreToolUse updated input", async () => {
    const cwd = await workspace();

    const runtime = new HookRuntime({
      PreToolUse: [{
        matcher: "Write",
        hooks: [{ type: "command", command: "verify-write" }]
      }]
    }, {
      commandExecutor: (_hook, input) => ({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { originalTool: input.tool_name, changed: true }
          }
        }),
        stderr: "",
        exitCode: 0
      })
    });

    const result = await runtime.run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "a.txt" } }, {
      cwd,
      sessionId: "session-1"
    });

    assert.equal(result.executed, 1);
    assert.deepEqual(result.updatedInput, { originalTool: "Write", changed: true });
  });

  it("supports function hooks as session hooks", async () => {
    const runtime = new HookRuntime();
    runtime.addFunctionHook("Stop", "", {
      type: "function",
      callback: () => ({ continue: false, stopReason: "not yet" })
    });

    const result = await runtime.run("Stop", {}, {
      cwd: await workspace(),
      sessionId: "session-1"
    });

    assert.equal(result.executed, 1);
    assert.equal(result.preventContinuation, true);
    assert.equal(result.stopReason, "not yet");
  });

  it("executes prompt hooks through the supplied model provider", async () => {
    const provider: ModelProvider = {
      async generate(request: ModelRequest) {
        assert.equal(request.model, "fast-hook");
        return { content: JSON.stringify({ ok: false, reason: "missing tests" }) };
      }
    };
    const runtime = new HookRuntime({
      Stop: [{
        hooks: [{ type: "prompt", prompt: "Verify $ARGUMENTS", model: "fast-hook" }]
      }]
    });

    const result = await runtime.run("Stop", { messages: [] }, {
      cwd: await workspace(),
      sessionId: "session-1",
      provider,
      model: "default"
    });

    assert.equal(result.executed, 1);
    assert.equal(result.blockingErrors[0]?.blockingError, "missing tests");
  });

  it("executes agent hooks as a constrained child tool loop", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request: ModelRequest) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: "",
            tool_calls: [{ id: "tool-1", name: "InspectContext", input: { topic: "hooks" } }]
          };
        }
        assert.match(JSON.stringify(request.messages), /inspected hooks/);
        return { content: JSON.stringify({ ok: false, reason: "agent found missing guard" }) };
      }
    };
    const runtime = new HookRuntime({
      Stop: [{
        hooks: [{ type: "agent", prompt: "Review $ARGUMENTS", model: "agent-hook" }]
      }]
    });

    const result = await runtime.run("Stop", { messages: [] }, {
      cwd: await workspace(),
      sessionId: "session-1",
      provider,
      model: "default",
      tools: [{
        name: "InspectContext",
        description: "Inspect context",
        input_schema: { type: "object" },
        isReadOnly: () => true,
        execute: async (input) => ({ output: `inspected ${(input as { topic: string }).topic}` })
      }]
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.model, "agent-hook");
    assert.equal(result.executed, 1);
    assert.equal(result.blockingErrors[0]?.blockingError, "agent found missing guard");
  });

  it("reports hook diagnostics including wired status and last execution", async () => {
    const runtime = new HookRuntime({
      Stop: [{
        matcher: "*",
        hooks: [{ type: "command", command: "stop-check" }]
      }],
      SessionStart: [{
        hooks: [{ type: "prompt", prompt: "session check" }]
      }]
    }, {
      commandExecutor: () => ({ stdout: "", stderr: "", exitCode: 0 })
    });
    runtime.addFunctionHook("PreToolUse", "Write", {
      type: "function",
      callback: () => true
    });

    await runtime.run("Stop", {}, {
      cwd: await workspace(),
      sessionId: "session-1"
    });

    const diagnostics = runtime.getDiagnostics();
    const stop = diagnostics.find((item) => item.event === "Stop" && item.command === "stop-check");
    const sessionStart = diagnostics.find((item) => item.event === "SessionStart");
    const preTool = diagnostics.find((item) => item.event === "PreToolUse");

    assert.equal(stop?.source, "settings");
    assert.equal(stop?.wired, true);
    assert.equal(stop?.lastExecution?.outcome, "success");
    assert.equal(sessionStart?.wired, false);
    assert.equal(preTool?.source, "builtin");
    assert.equal(preTool?.matcher, "Write");
  });

  it("clears session-scoped hooks for a completed session", async () => {
    const runtime = new HookRuntime();
    runtime.addSessionHooks({
      Stop: [{ hooks: [{ type: "command", command: "session-stop" }] }]
    }, { source: "session", sessionId: "session-1" });
    runtime.addSessionHooks({
      Stop: [{ hooks: [{ type: "command", command: "skill-stop" }] }]
    }, { source: "skill", sessionId: "session-1", skillName: "reviewer" });
    runtime.addSessionHooks({
      Stop: [{ hooks: [{ type: "command", command: "other-session-stop" }] }]
    }, { source: "skill", sessionId: "session-2", skillName: "reviewer" });

    runtime.clearSessionHooks("session-1");

    const diagnostics = runtime.getDiagnostics();
    assert.equal(diagnostics.some((hook) => hook.command === "session-stop"), false);
    assert.equal(diagnostics.some((hook) => hook.command === "skill-stop"), false);
    assert.equal(diagnostics.some((hook) => hook.command === "other-session-stop"), true);
  });
});

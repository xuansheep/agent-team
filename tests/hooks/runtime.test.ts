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
});

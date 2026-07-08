import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HookRuntime, type CommandHookExecutor } from "../../src/hooks/runtime.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { RunStore } from "../../src/storage/runStore.js";

describe("WorkflowEngine hooks", () => {
  it("passes hook runtime to workflow tool execution", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "writing artifact",
            tool_calls: [{
              id: "tool-1",
              name: "ArtifactWrite",
              input: { name: "old.md", content: "old", description: "old artifact" }
            }]
          };
        }
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const hookEvents: string[] = [];
    const commandExecutor: CommandHookExecutor = (hook, input) => {
      hookEvents.push(`${input.hook_event_name}:${input.tool_name}`);
      if (input.hook_event_name === "PreToolUse") {
        assert.deepEqual(input.tool_input, { name: "old.md", content: "old", description: "old artifact" });
        return {
          stdout: JSON.stringify({
            hookSpecificOutput: {
              updatedInput: { name: "new.md", content: "new", description: "hooked artifact" }
            }
          }),
          stderr: "",
          exitCode: 0
        };
      }
      assert.equal(hook.command, "after-artifact");
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const hookRuntime = new HookRuntime({
      PreToolUse: [{ matcher: "ArtifactWrite", hooks: [{ type: "command", command: "rewrite-artifact" }] }],
      PostToolUse: [{ matcher: "ArtifactWrite", hooks: [{ type: "command", command: "after-artifact" }] }]
    }, { commandExecutor });
    const runRoot = `.tmp/workflow-hook-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot, hookRuntime });

    const result = await engine.run({
      providers: { default: { type: "openai-compatible", base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
      roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default", permissions: { allow: ["ArtifactWrite"], ask: [], deny: [] } }], edges: [] } }
    }, "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.deepEqual(hookEvents, ["PreToolUse:ArtifactWrite", "PostToolUse:ArtifactWrite"]);
    const lastResult = result.attempts.at(-1)?.result as { deliverables: Array<{ artifact_id: string; description: string }> };
    const artifact = lastResult.deliverables[0];
    assert.deepEqual(artifact, { artifact_id: "dev/new.md", description: "hooked artifact" });
    const runId = await latestRunId(runRoot);
    assert.equal(await readFile(join(await runDirForRun(runRoot, runId), "artifacts", "dev", "new.md"), "utf8"), "new");
  });

  it("adds UserPromptSubmit hook context to workflow model requests", async () => {
    let firstRequest: ModelRequest | undefined;
    const provider: ModelProvider = {
      async generate(request) {
        firstRequest = request;
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const hookRuntime = new HookRuntime({
      UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "add-context" }] }]
    }, {
      commandExecutor: () => ({
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "Context from hook" } }),
        stderr: "",
        exitCode: 0
      })
    });
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/workflow-user-hook-runs-${Date.now()}`, hookRuntime });

    const result = await engine.run(baseConfig({ toolCalling: false }), "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.match(allRequestText(firstRequest), /Context from hook/);
  });

  it("runs PostToolUseFailure hooks when workflow tools fail", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "writing invalid artifact",
            tool_calls: [{
              id: "tool-1",
              name: "ArtifactWrite",
              input: { name: "../bad.md", content: "bad", description: "bad artifact" }
            }]
          };
        }
        return { content: JSON.stringify({ status: "success", summary: "recovered", handoff: { instruction: "next" } }) };
      }
    };
    const hookEvents: string[] = [];
    const hookRuntime = new HookRuntime({
      PostToolUseFailure: [{ matcher: "ArtifactWrite", hooks: [{ type: "command", command: "record-failure" }] }]
    }, {
      commandExecutor: (_hook, input) => {
        hookEvents.push(`${input.hook_event_name}:${input.tool_name}:${String(input.error)}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/workflow-hook-failure-runs-${Date.now()}`, hookRuntime });

    const result = await engine.run(baseConfig({ toolCalling: true, allow: ["ArtifactWrite"] }), "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.match(hookEvents[0] ?? "", /^PostToolUseFailure:ArtifactWrite:Invalid artifact name/);
  });

  it("uses Stop hooks to force workflow continuation", async () => {
    let calls = 0;
    let stopHooks = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: JSON.stringify({ status: "success", summary: `done ${calls}`, handoff: { instruction: "next" } }) };
      }
    };
    const hookRuntime = new HookRuntime({
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: "verify-stop" }] }]
    }, {
      commandExecutor: () => {
        stopHooks += 1;
        if (stopHooks === 1) {
          return { stdout: JSON.stringify({ continue: false, reason: "needs another pass" }), stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/workflow-stop-hook-runs-${Date.now()}`, hookRuntime });

    const result = await engine.run(baseConfig({ toolCalling: false }), "flow", { request: "x" });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(stopHooks, 2);
    assert.equal((result.attempts.at(-1)?.result as { summary: string }).summary, "done 2");
  });
});

function baseConfig(options: { toolCalling: boolean; allow?: string[] }) {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: options.toolCalling, vision: false, streaming: false, json_schema_output: true } } },
    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: options.toolCalling, vision: false } } },
    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const, permissions: { allow: options.allow ?? [], ask: [], deny: [] } }], edges: [] } }
  };
}

function allRequestText(request: ModelRequest | undefined): string {
  return request?.messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
  }).join("\n\n") ?? "";
}

async function latestRunId(runRoot: string): Promise<string> {
  return (await new RunStore(runRoot).listRuns({ limit: 1 }))[0]?.runId ?? "";
}

async function runDirForRun(runRoot: string, runId: string): Promise<string> {
  return (await new RunStore(runRoot).listRuns()).find((run) => run.runId === runId)?.runDir ?? join(runRoot, runId);
}

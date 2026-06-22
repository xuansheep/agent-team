import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNode } from "../../src/harness/runtime.js";
import { RunStore } from "../../src/storage/runStore.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ModelProvider } from "../../src/providers/types.js";

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
          return { tool_calls: [{ id: "tool-1", name: "Bash", input: { command: "npm test" } }] };
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
});

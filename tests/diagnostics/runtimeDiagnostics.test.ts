import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectRuntimeDiagnostics } from "../../src/diagnostics/runtimeDiagnostics.js";
import { HookRuntime } from "../../src/hooks/runtime.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { SkillRuntime } from "../../src/skills/runtime.js";

describe("runtime diagnostics", () => {
  it("collects MCP, skill, and hook diagnostics for TUI surfaces", async () => {
    const mcpRuntime = new McpRuntime({
      clientFactory: async () => ({
        listTools: async () => [{ name: "search" }],
        callTool: async () => ({}),
        listResources: async () => [{ uri: "file://readme" }],
        readResource: async () => ({ uri: "file://readme", contents: [] }),
        listPrompts: async () => [{ name: "explain" }],
        getPrompt: async () => ({ name: "explain", messages: [] })
      })
    });
    await mcpRuntime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);
    const skillRuntime = new SkillRuntime([{
      name: "planner",
      prompt: "Plan.",
      path: "SKILL.md",
      root: ".",
      source: "project",
      mode: "inline"
    }]);
    const hookRuntime = new HookRuntime({
      Stop: [{ hooks: [{ type: "command", command: "verify" }] }]
    });

    const diagnostics = collectRuntimeDiagnostics({ mcpRuntime, skillRuntime, hookRuntime });

    assert.equal(diagnostics.mcp[0]?.name, "docs");
    assert.equal(diagnostics.skills[0]?.name, "planner");
    assert.equal(diagnostics.hooks[0]?.event, "Stop");
  });
});

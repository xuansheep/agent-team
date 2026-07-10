import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectRuntimeDiagnostics } from "../../src/diagnostics/runtimeDiagnostics.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { SkillRuntime } from "../../src/skills/runtime.js";

describe("runtime diagnostics", () => {
  it("collects MCP and skill diagnostics for TUI surfaces", async () => {
    const mcpRuntime = new McpRuntime({
      clientFactory: async () => ({
        initialize: async () => undefined,
        getMetadata: () => ({ capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "docs", version: "1.0.0" } }),
        onListChanged: () => undefined,
        listTools: async () => [{ name: "search" }],
        callTool: async () => ({ content: [] }),
        listResources: async () => [{ uri: "file://readme", name: "readme" }],
        readResource: async () => ({ contents: [] }),
        listPrompts: async () => [{ name: "explain" }],
        getPrompt: async () => ({ messages: [] }),
        close: async () => undefined
      })
    });
    await mcpRuntime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);
    const skillRuntime = new SkillRuntime([{
      name: "planner",
      prompt: "Plan.",
      path: "SKILL.md",
      root: ".",
      source: "project",
      mode: "inline",
      userInvocable: true,
      disableModelInvocation: false,
      metadata: {}
    }]);

    const diagnostics = collectRuntimeDiagnostics({ mcpRuntime, skillRuntime });

    assert.equal(diagnostics.mcp[0]?.name, "docs");
    assert.equal(diagnostics.mcp[0]?.serverInfo?.version, "1.0.0");
    assert.equal(diagnostics.skills[0]?.name, "planner");
  });
});
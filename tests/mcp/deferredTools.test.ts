import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeferredMcpTool, createMcpToolSearchTool, syncMcpRegistry } from "../../src/mcp/deferredTools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { RuntimeMcpTool } from "../../src/mcp/runtime.js";

const tools: RuntimeMcpTool[] = [
  { server: "docs", originalName: "search", name: "mcp__docs__search", description: "Search docs", inputSchema: { type: "object" } },
  { server: "repo", originalName: "findFile", name: "mcp__repo__findFile", description: "Find files", inputSchema: { type: "object" } }
];

describe("deferred MCP tools", () => {
  it("searches MCP tools by name and description", async () => {
    const tool = createMcpToolSearchTool({ listTools: () => tools });

    const result = await tool.execute({ query: "docs" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /mcp__docs__search/);
    assert.doesNotMatch(result.output ?? "", /mcp__repo__findFile/);
  });

  it("supports required terms, explicit selection, pending servers, and always-load tools", async () => {
    const registry = new ToolRegistry();
    const searchable = createMcpToolSearchTool({
      listTools: () => tools,
      listServerStatuses: () => [{ name: "late", state: "pending" }],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] })
    });

    const required = await searchable.execute({ query: "find +files" }, { cwd: process.cwd(), toolRegistry: registry });
    assert.deepEqual((required.data as { matches: Array<{ name: string }> }).matches.map((match) => match.name), ["mcp__repo__findFile"]);

    const selected = await searchable.execute({ query: "select:mcp__docs__search,missing_tool" }, { cwd: process.cwd(), toolRegistry: registry });
    assert.equal(registry.has("mcp__docs__search"), true);
    assert.deepEqual((selected.data as { missing?: string[] }).missing, ["missing_tool"]);

    const pending = await createMcpToolSearchTool({
      listTools: () => [],
      listServerStatuses: () => [{ name: "late", state: "pending" }]
    }).execute({ query: "anything" }, { cwd: process.cwd() });
    assert.deepEqual((pending.data as { pending_mcp_servers?: string[] }).pending_mcp_servers, ["late"]);

    const alwaysLoad = { ...tools[0], _meta: { "anthropic/alwaysLoad": true } };
    const alwaysRegistry = new ToolRegistry();
    syncMcpRegistry(alwaysRegistry, { listTools: () => [alwaysLoad], callTool: async () => ({}) });
    assert.equal(alwaysRegistry.has(alwaysLoad.name), true);
  });

  it("invokes a deferred MCP tool through runtime", async () => {
    const called: unknown[] = [];
    const tool = createDeferredMcpTool(tools[0], {
      callTool: async (server, originalName, input) => {
        called.push({ server, originalName, input });
        return { ok: true };
      }
    });

    const result = await tool.execute({ q: "abc" }, { cwd: process.cwd() });

    assert.deepEqual(called, [{ server: "docs", originalName: "search", input: { q: "abc" } }]);
    assert.deepEqual(result.data, { ok: true });
  });
});

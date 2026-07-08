import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeferredMcpTool, createMcpToolSearchTool } from "../../src/mcp/deferredTools.js";
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

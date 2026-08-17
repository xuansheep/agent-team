import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDiscoveredMcpTools,
  mergePreCompactDiscoveredTools,
  prepareMcpDiscovery,
  withMcpCatalogMessage
} from "../../src/mcp/discovery.js";
import { createMcpToolSearchTool } from "../../src/mcp/deferredTools.js";
import type { RuntimeMcpTool } from "../../src/mcp/runtime.js";
import { compactSummaryMessage } from "../../src/model/contextCompaction.js";
import { toolResultMessage } from "../../src/tools/modelResult.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const mcpTools: RuntimeMcpTool[] = [
  { server: "playwright", originalName: "navigate", name: "mcp__playwright__navigate", description: "Navigate a browser", inputSchema: { type: "object" } },
  { server: "docs", originalName: "search", name: "mcp__docs__search", description: "Search private docs", inputSchema: { type: "object" } }
];

describe("MCP deferred discovery protocol", () => {
  it("publishes a sorted name-only catalog and filters denied server prefixes", () => {
    const registry = new ToolRegistry();
    const runtime = {
      listTools: () => mcpTools,
      listServerStatuses: () => [
        { name: "late", state: "pending" as const },
        { name: "broken", state: "failed" as const, error: "bad\u0000server" }
      ],
      getCatalogRevision: () => 7,
      callTool: async () => ({})
    };

    const snapshot = prepareMcpDiscovery({
      runtime,
      registry,
      messages: [],
      permissions: { deny: ["mcp__docs"] }
    });
    const messages = withMcpCatalogMessage([
      { role: "user", content: "test" },
      compactSummaryMessage("earlier context")
    ], snapshot);
    const catalogMessage = messages.find((message) => message.metadata?.runtimeAttachment?.type === "mcp_catalog");
    const catalog = String(catalogMessage?.content);

    assert.deepEqual(snapshot.deferredToolNames, ["mcp__playwright__navigate"]);
    assert.match(catalog, /<available-deferred-tools>\nmcp__playwright__navigate\n<\/available-deferred-tools>/);
    assert.doesNotMatch(catalog, /Navigate a browser|Search private docs|mcp__docs__search/);
    assert.doesNotMatch(catalog, /late: pending|broken: failed|badserver/);
    assert.equal(catalogMessage?.metadata?.runtimeAttachment?.humanTurnCount, 1);
  });

  it("restores discovered schemas from durable ToolSearch history and compaction metadata", () => {
    const registry = new ToolRegistry();
    const messages = [
      { role: "assistant" as const, content: "", tool_calls: [{ id: "search-1", name: "ToolSearch", input: { query: "playwright" } }] },
      {
        role: "tool" as const,
        tool_call_id: "search-1",
        content: JSON.stringify({
          data: {
            kind: "mcp_tool_search",
            matches: [{ name: "mcp__playwright__navigate" }]
          }
        })
      }
    ];
    const runtime = { listTools: () => mcpTools, callTool: async () => ({}) };

    const snapshot = prepareMcpDiscovery({ runtime, registry, messages });

    assert.deepEqual(snapshot.discoveredToolNames, ["mcp__playwright__navigate"]);
    assert.deepEqual(snapshot.deferredToolNames, ["mcp__docs__search", "mcp__playwright__navigate"]);
    assert.equal(registry.has("mcp__playwright__navigate"), true);

    const summary = mergePreCompactDiscoveredTools(compactSummaryMessage("continue"), messages);
    assert.deepEqual(summary.metadata?.mcpDiscovery?.preCompactDiscoveredTools, ["mcp__playwright__navigate"]);
    assert.deepEqual(extractDiscoveredMcpTools([summary]), ["mcp__playwright__navigate"]);
  });

  it("maps ToolSearch matches to Anthropic tool_reference blocks and records discovery metadata", async () => {
    const registry = new ToolRegistry();
    const search = createMcpToolSearchTool({
      listTools: () => mcpTools,
      callTool: async () => ({})
    });
    const context = {
      cwd: process.cwd(),
      model: "claude-test",
      provider: { generate: async () => ({}), deferredToolProtocol: () => "anthropic-tool-reference" as const },
      toolRegistry: registry
    };
    const result = await search.execute({ query: "select:mcp__playwright__navigate" }, context);
    const message = toolResultMessage("search-1", result, search, context);

    assert.deepEqual(message.content, [{ type: "tool_reference", tool_name: "mcp__playwright__navigate" }]);
    assert.deepEqual(message.metadata?.mcpDiscovery?.discoveredTools, ["mcp__playwright__navigate"]);
  });
});

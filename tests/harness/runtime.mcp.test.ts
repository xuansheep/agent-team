import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runNode } from "../../src/harness/runtime.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpClient, McpPrompt, McpResource, McpTool } from "../../src/mcp/types.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { RunStore } from "../../src/storage/runStore.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

class PlaywrightClient implements McpClient {
  calls: Array<{ name: string; input: unknown }> = [];

  async listTools(): Promise<McpTool[]> {
    return [{ name: "browser_navigate", description: "Navigate browser", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }];
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    this.calls.push({ name, input });
    return { content: [{ type: "text", text: "page loaded" }] };
  }

  async listResources(): Promise<McpResource[]> { return []; }
  async readResource(): Promise<unknown> { return {}; }
  async listPrompts(): Promise<McpPrompt[]> { return []; }
  async getPrompt(): Promise<unknown> { return {}; }
}

describe("runNode MCP deferred discovery", () => {
  it("discovers and invokes Playwright MCP instead of requiring a browser subprocess", async () => {
    const client = new PlaywrightClient();
    const runtime = new McpRuntime({ clientFactory: async () => client });
    await runtime.connectAll([{ name: "playwright", source: "project", type: "http", url: "https://mcp.example.test" }]);
    const registry = createLocalToolRegistry({ mcpRuntime: runtime });
    const root = `.tmp/runtime-mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "test site" });
    let requests = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests += 1;
        if (requests === 1) {
          const catalog = request.messages.find((message) => message.metadata?.runtimeAttachment?.type === "mcp_catalog");
          assert.match(String(catalog?.content), /mcp__playwright__browser_navigate/);
          assert.equal(request.tools.some((tool) => tool.name === "mcp__playwright__browser_navigate"), false);
          return {
            content: "Loading the Playwright schema.",
            tool_calls: [{
              id: "search-1",
              name: "ToolSearch",
              input: { query: "select:mcp__playwright__browser_navigate" }
            }]
          };
        }
        if (requests === 2) {
          assert.equal(request.tools.some((tool) => tool.name === "mcp__playwright__browser_navigate"), false);
          assert.equal(request.tools.some((tool) => tool.name === "McpInvoke"), true);
          return {
            content: "Opening the page through MCP.",
            tool_calls: [{
              id: "navigate-1",
              name: "McpInvoke",
              input: {
                name: "mcp__playwright__browser_navigate",
                input: { url: "https://example.test" }
              }
            }]
          };
        }
        const result = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "navigate-1");
        assert.match(String(result?.content), /page loaded/);
        return {
          content: JSON.stringify({
            direction: "forward",
            summary: "Playwright MCP verification passed",
            handoff: { instruction: "deliver" }
          })
        };
      }
    };

    const result = await runNode({
      node: { id: "tester", role: "tester", provider: "default", permission_mode: "default" },
      systemPrompt: "Test the website.",
      model: "gpt-test",
      provider,
      tools: registry,
      permissions: { allow: ["mcp__playwright"], ask: [], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "test site" },
      attempt: 1,
      activation: 1
    });

    assert.equal(result.direction, "forward");
    assert.deepEqual(client.calls, [{ name: "browser_navigate", input: { url: "https://example.test" } }]);
    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) => event.type === "mcp_catalog_published"), true);
    assert.equal(events.some((event) => event.type === "mcp_tools_discovered"), true);
    assert.equal(events.some((event) => event.type === "tool_invoked" && event.tool === "mcp__playwright__browser_navigate" && event.via === "McpInvoke"), true);
    await runtime.closeAll();
  });
});

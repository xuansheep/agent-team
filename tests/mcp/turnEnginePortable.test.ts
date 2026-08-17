import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpClient, McpPrompt, McpResource, McpTool } from "../../src/mcp/types.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { TurnEngine } from "../../src/runtime/turnEngine.js";
import type { RuntimeEvent } from "../../src/runtime/types.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

class DocsClient implements McpClient {
  calls: Array<{ name: string; input: unknown }> = [];

  async listTools(): Promise<McpTool[]> {
    return [
      {
        name: "search",
        description: "Search docs",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        annotations: { readOnlyHint: true }
      },
      { name: "lookup", description: "Lookup docs", inputSchema: { type: "object" } }
    ];
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    this.calls.push({ name, input });
    return { content: [{ type: "text", text: "portable result" }] };
  }

  async listResources(): Promise<McpResource[]> { return []; }
  async readResource(): Promise<unknown> { return {}; }
  async listPrompts(): Promise<McpPrompt[]> { return []; }
  async getPrompt(): Promise<unknown> { return {}; }
}

describe("TurnEngine portable MCP exposure", () => {
  it("keeps a fixed proxy surface and resolves permission/events to the real MCP tool", async () => {
    const client = new DocsClient();
    const runtime = new McpRuntime({ clientFactory: async () => client });
    await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);
    const tools = createLocalToolRegistry({ mcpRuntime: runtime });
    const events: RuntimeEvent[] = [];
    let requests = 0;
    const provider: ModelProvider = {
      deferredToolProtocol: () => "portable",
      async generate(request) {
        requests += 1;
        const exposedMcpTools = request.tools
          .map((tool) => tool.name)
          .filter((name) => name === "ToolSearch" || name === "McpInvoke" || name.startsWith("mcp__") || name.includes("Mcp"));
        assert.deepEqual(exposedMcpTools, ["ToolSearch", "McpInvoke"]);
        assert.equal(request.deferredTools, undefined);
        if (requests === 1) {
          return { tool_calls: [{ id: "search-1", name: "ToolSearch", input: { query: "select:mcp__docs__search" } }] };
        }
        if (requests === 2) {
          const searchResult = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "search-1");
          assert.match(String(searchResult?.content), /input_schema/);
          assert.match(String(searchResult?.content), /readOnlyHint/);
          return {
            tool_calls: [{
              id: "invoke-1",
              name: "McpInvoke",
              input: { name: "mcp__docs__search", input: { query: "stable" } }
            }]
          };
        }
        const invokeResult = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "invoke-1");
        assert.match(String(invokeResult?.content), /portable result/);
        return { content: "done" };
      }
    };

    const result = await new TurnEngine().execute({
      messages: [{ role: "user", content: "search docs" }],
      model: "portable-test",
      provider,
      tools,
      permissions: { mode: "default", allow: ["ToolSearch", "mcp__docs"], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "portable-mcp",
      eventSink: (event) => { events.push(event); }
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(client.calls, [{ name: "search", input: { query: "stable" } }]);
    assert.equal(events.some((event) => event.type === "runtime_tool_invoked" && event.tool === "mcp__docs__search" && (event as typeof event & { via?: string }).via === "McpInvoke"), true);
    assert.equal(events.some((event) => event.type === "runtime_tool_invoked" && event.tool === "McpInvoke"), false);
    await runtime.closeAll();
  });

  it("keeps Anthropic native deferred names and order stable after discovery", async () => {
    const client = new DocsClient();
    const runtime = new McpRuntime({ clientFactory: async () => client });
    await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);
    const tools = createLocalToolRegistry({ mcpRuntime: runtime });
    let requests = 0;
    const provider: ModelProvider = {
      deferredToolProtocol: () => "anthropic-tool-reference",
      async generate(request) {
        requests += 1;
        assert.deepEqual(request.deferredToolNames, ["mcp__docs__lookup", "mcp__docs__search"]);
        assert.deepEqual(request.deferredTools?.map((tool) => tool.name), request.deferredToolNames);
        assert.equal(request.tools.some((tool) => tool.name === "McpInvoke" || tool.name.startsWith("mcp__")), false);
        if (requests === 1) {
          return { tool_calls: [{ id: "search-1", name: "ToolSearch", input: { query: "select:mcp__docs__search" } }] };
        }
        if (requests === 2) {
          return { tool_calls: [{ id: "invoke-1", name: "mcp__docs__search", input: { query: "native" } }] };
        }
        return { content: "done" };
      }
    };

    const result = await new TurnEngine().execute({
      messages: [{ role: "user", content: "search docs" }],
      model: "claude-test",
      provider,
      tools,
      permissions: { mode: "default", allow: ["ToolSearch", "mcp__docs"], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "native-mcp"
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(client.calls, [{ name: "search", input: { query: "native" } }]);
    await runtime.closeAll();
  });
});

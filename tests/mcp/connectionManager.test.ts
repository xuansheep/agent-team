import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { createMcpClientFactory } from "../../src/mcp/transports.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import type { McpClient, McpPrompt, McpResource, McpTool } from "../../src/mcp/types.js";

class FakeMcpClient implements McpClient {
  constructor(private readonly tools: McpTool[] = []) {}

  async listTools(): Promise<McpTool[]> {
    return this.tools;
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    return { name, input };
  }

  async listResources(): Promise<McpResource[]> {
    return [{ uri: "file://readme", name: "Readme", mimeType: "text/plain" }];
  }

  async readResource(uri: string): Promise<unknown> {
    return { uri, contents: [{ type: "text", text: "hello", mimeType: "text/plain" }] };
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return [{ name: "explain", description: "Explain code", arguments: [] }];
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    return { name, messages: [{ role: "user", content: `prompt ${args.topic}` }] };
  }
}

describe("McpRuntime", () => {
  it("connects servers and caches tools, resources, and prompts", async () => {
    const runtime = new McpRuntime({
      clientFactory: async () => new FakeMcpClient([{ name: "search", description: "Search", inputSchema: { type: "object" } }])
    });

    await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);

    assert.equal(runtime.getServerStatus("docs")?.state, "connected");
    assert.equal(runtime.listTools()[0]?.name, "mcp__docs__search");
    assert.equal((await runtime.listResources({ server: "docs" }))[0]?.uri, "file://readme");
    assert.equal((await runtime.listPrompts({ server: "docs" }))[0]?.name, "explain");
  });

  it("marks only the failing server as failed", async () => {
    const runtime = new McpRuntime({
      clientFactory: async (server) => {
        if (server.name === "bad") throw new Error("boom");
        return new FakeMcpClient();
      }
    });

    await runtime.connectAll([
      { name: "ok", source: "project", type: "http", url: "https://ok.example.test" },
      { name: "bad", source: "project", type: "http", url: "https://bad.example.test" }
    ]);

    assert.equal(runtime.getServerStatus("ok")?.state, "connected");
    assert.equal(runtime.getServerStatus("bad")?.state, "failed");
  });

  it("creates a client factory for every phase-one transport type", async () => {
    const created: string[] = [];
    const factory = createMcpClientFactory({
      createClient: async (server) => {
        created.push(server.type);
        return new FakeMcpClient();
      }
    });

    await factory({ name: "stdio", source: "project", type: "stdio", command: "node" });
    await factory({ name: "http", source: "project", type: "http", url: "https://mcp.example.test" });
    await factory({ name: "sse", source: "project", type: "sse", url: "https://mcp.example.test/sse" });
    await factory({ name: "ws", source: "project", type: "ws", url: "wss://mcp.example.test/ws" });

    assert.deepEqual(created, ["stdio", "http", "sse", "ws"]);
  });

  it("registers MCP tools when runtime is supplied", async () => {
    const runtime = new McpRuntime({
      clientFactory: async () => new FakeMcpClient([{ name: "search", description: "Search", inputSchema: { type: "object" } }])
    });
    await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);

    const registry = createLocalToolRegistry({ mcpRuntime: runtime });

    assert.ok(registry.get("ToolSearch"));
    assert.ok(registry.get("ListMcpResources"));
    assert.ok(registry.get("ReadMcpResource"));
    assert.ok(registry.get("ListMcpPrompts"));
    assert.ok(registry.get("GetMcpPrompt"));
    assert.ok(registry.get("RunMcpPrompt"));
    assert.ok(registry.get("mcp__docs__search"));
  });

  it("returns MCP diagnostics for connected, failed, and disabled servers", async () => {
    const runtime = new McpRuntime({
      clientFactory: async (server) => {
        if (server.name === "bad") throw new Error("boom");
        return new FakeMcpClient([{ name: "search", description: "Search", inputSchema: { type: "object" } }]);
      }
    });

    await runtime.connectAll([
      { name: "ok", source: "project", type: "http", url: "https://ok.example.test" },
      { name: "bad", source: "project", type: "http", url: "https://bad.example.test" },
      { name: "off", source: "project", type: "http", url: "https://off.example.test", disabled: true }
    ]);

    const diagnostics = runtime.getDiagnostics();

    assert.deepEqual(diagnostics.map((item) => item.state).sort(), ["connected", "disabled", "failed"]);
    assert.equal(diagnostics.find((item) => item.name === "ok")?.toolCount, 1);
    assert.equal(diagnostics.find((item) => item.name === "bad")?.error, "boom");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { McpClient } from "../../src/mcp/types.js";
import { createMcpClientFactory } from "../../src/mcp/transports.js";

describe("official MCP client factory", () => {
  it("uses an injected client factory without invoking a transport", async () => {
    const client: McpClient = {
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      listPrompts: async () => [],
      getPrompt: async () => ({ messages: [] })
    };
    const factory = createMcpClientFactory({ createClient: async () => client });

    const created = await factory({ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" });

    assert.equal(created, client);
  });
});
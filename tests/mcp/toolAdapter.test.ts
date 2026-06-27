import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { InMemoryMcpClient } from "../../src/mcp/client.js";
import { registerMcpTools } from "../../src/mcp/toolAdapter.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Tool } from "../../src/tools/types.js";

describe("MCP tool adapter", () => {
  it("injects MCP tools into a ToolRegistry", async () => {
    const registry = new ToolRegistry();
    const client = new InMemoryMcpClient([{
      name: "McpEcho",
      description: "Echo input",
      inputSchema: { type: "object" },
      readOnly: true,
      execute: (input) => ({ content: [{ type: "text", text: JSON.stringify(input) }] })
    }]);

    await registerMcpTools(client, registry);
    const result = await registry.get("McpEcho").execute({ value: 1 }, { cwd: process.cwd() });

    assert.equal(result.output, "{\"value\":1}");
  });

  it("rejects duplicate tool names instead of overriding existing tools", async () => {
    const registry = new ToolRegistry();
    registry.add(simpleTool("McpEcho"));
    const client = new InMemoryMcpClient([{
      name: "McpEcho",
      execute: () => ({ content: [{ type: "text", text: "replacement" }] })
    }]);

    await assert.rejects(() => registerMcpTools(client, registry), /Duplicate tool McpEcho/);
  });

  it("cannot bypass Plan Mode permissions", async () => {
    const registry = new ToolRegistry();
    const client = new InMemoryMcpClient([{
      name: "McpWrite",
      description: "External write",
      execute: () => ({ content: [{ type: "text", text: "wrote" }] })
    }]);
    await registerMcpTools(client, registry);

    const decision = await checkToolPermission(registry.get("McpWrite"), {}, {
      mode: "plan",
      cwd: process.cwd(),
      allow: [],
      ask: [],
      deny: []
    });

    assert.equal(decision.decision, "deny");
  });
});

function simpleTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    async execute() {
      return { output: name };
    }
  };
}

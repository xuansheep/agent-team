import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGetMcpPromptTool, createListMcpPromptsTool, createRunMcpPromptTool } from "../../src/mcp/promptTools.js";

describe("MCP prompt tools", () => {
  it("lists prompts", async () => {
    const tool = createListMcpPromptsTool({
      listPrompts: async () => [{ server: "docs", name: "explain", description: "Explain code", arguments: [] }]
    });

    const result = await tool.execute({ server: "docs" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /docs explain/);
  });

  it("gets prompt metadata", async () => {
    const tool = createGetMcpPromptTool({
      listPrompts: async () => [{ server: "docs", name: "explain", description: "Explain code", arguments: [{ name: "topic", required: true }] }]
    });

    const result = await tool.execute({ server: "docs", name: "explain" }, { cwd: process.cwd() });

    assert.deepEqual((result.data as { name: string }).name, "explain");
  });

  it("runs a prompt", async () => {
    const tool = createRunMcpPromptTool({
      getPrompt: async (_server, name, args) => ({ name, messages: [{ role: "user", content: `explain ${args.topic}` }] })
    });

    const result = await tool.execute({ server: "docs", name: "explain", arguments: { topic: "MCP" } }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /explain MCP/);
  });
});

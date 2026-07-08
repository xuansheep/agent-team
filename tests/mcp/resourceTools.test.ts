import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createListMcpResourcesTool, createReadMcpResourceTool } from "../../src/mcp/resourceTools.js";

describe("MCP resource tools", () => {
  it("lists resources", async () => {
    const tool = createListMcpResourcesTool({
      listResources: async () => [{ server: "docs", uri: "file://readme", name: "Readme", mimeType: "text/plain" }]
    });

    const result = await tool.execute({ server: "docs" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /file:\/\/readme/);
  });

  it("reads text resources", async () => {
    const tool = createReadMcpResourceTool({
      readResource: async () => ({ uri: "file://readme", contents: [{ type: "text", text: "hello", mimeType: "text/plain" }] })
    });

    const result = await tool.execute({ server: "docs", uri: "file://readme" }, { cwd: process.cwd() });

    assert.equal(result.output, "hello");
  });
});

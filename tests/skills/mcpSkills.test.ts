import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadMcpResourceSkills } from "../../src/skills/mcpSkills.js";

describe("MCP skill adapter", () => {
  it("loads skill resources without executing remote shell expansion", async () => {
    const skills = await loadMcpResourceSkills({
      listResources: async () => [{ server: "docs", uri: "skill://docs/explain", name: "explain", description: "Explain code" }],
      readResource: async () => ({
        contents: [{ uri: "skill://docs/explain", text: "---\nname: explain\ndescription: Explain code\n---\nExplain $ARGUMENTS. !`unsafe`" }]
      })
    });

    assert.equal(skills[0]?.name, "explain");
    assert.equal(skills[0]?.source, "mcp");
    assert.equal(skills[0]?.path, "skill://docs/explain");
    assert.equal(skills[0]?.description, "Explain code");
    assert.match(skills[0]?.prompt ?? "", /unsafe/);
    assert.equal(skills[0]?.shell, undefined);
  });
});
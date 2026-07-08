import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadMcpPromptSkills } from "../../src/skills/mcpSkills.js";

describe("MCP skill adapter", () => {
  it("adapts MCP prompts into skill records without registering prompt slash commands", async () => {
    const skills = await loadMcpPromptSkills({
      listPrompts: async () => [
        {
          server: "docs",
          name: "explain",
          description: "Explain code",
          arguments: [{ name: "topic", required: true }]
        }
      ]
    });

    assert.equal(skills[0]?.name, "mcp__docs__explain");
    assert.equal(skills[0]?.source, "mcp");
    assert.equal(skills[0]?.path, "mcp://docs/prompts/explain");
    assert.match(skills[0]?.prompt ?? "", /RunMcpPrompt/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePermission } from "../../src/harness/permissions.js";

describe("decidePermission", () => {
  it("denies before allow", () => {
    const decision = decidePermission("Read", "./.env", {
      allow: ["Read"],
      ask: [],
      deny: ["Read(./.env)"]
    });

    assert.deepEqual(decision, { decision: "deny", rule: "Read(./.env)" });
  });

  it("matches tool-only allow", () => {
    const decision = decidePermission("LS", ".", {
      allow: ["LS"],
      ask: [],
      deny: []
    });

    assert.equal(decision.decision, "allow");
  });

  it("matches bash wildcard specifier", () => {
    const decision = decidePermission("Bash", "npm test -- tests/config/loadConfig.test.ts", {
      allow: ["Bash(npm test *)"],
      ask: [],
      deny: []
    });

    assert.equal(decision.decision, "allow");
  });

  it("matches conservative Bash prompt permission rules", () => {
    assert.equal(decidePermission("Bash", "node --test --help", {
      allow: ["Bash(prompt:run tests)"],
      ask: [],
      deny: []
    }).decision, "allow");

    assert.equal(decidePermission("Bash", "npm test && rm -rf dist", {
      allow: ["Bash(prompt:run tests)"],
      ask: [],
      deny: []
    }).decision, "ask");

    assert.equal(decidePermission("Bash", "npm install", {
      allow: ["Bash(prompt:install dependencies)"],
      ask: [],
      deny: []
    }).decision, "allow");
  });

  it("matches an MCP server prefix against every tool from that server", () => {
    assert.equal(decidePermission("mcp__playwright__navigate", "", {
      allow: [],
      ask: [],
      deny: ["mcp__playwright"]
    }).decision, "deny");

    assert.equal(decidePermission("mcp__docs__search", "", {
      allow: ["mcp__docs"],
      ask: [],
      deny: []
    }).decision, "allow");
  });
});

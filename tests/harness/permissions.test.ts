import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePermission, isToolExplicitlyDenied } from "../../src/harness/permissions.js";

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
  it("matches Bash deny and ask rules against safe compound command segments", () => {
    const commands = [
      "rm -rf dist",
      "pwd; rm -rf dist",
      "pwd && rm -rf dist",
      "false || rm -rf dist",
      "printf x | rm -rf dist",
      "(rm -rf dist)",
      "cd /d/work/code-ai/random && (pkill -f \"http.server 8137\" 2>/dev/null; pkill -f \"8137\" 2>/dev/null); rm -f weather-desktop.png; rm -rf .playwright-mcp; ls -la"
    ];
    for (const command of commands) {
      assert.deepEqual(decidePermission("Bash", command, {
        allow: ["Bash"],
        ask: [],
        deny: ["Bash(rm *)"]
      }), { decision: "deny", rule: "Bash(rm *)" });
    }

    assert.deepEqual(decidePermission("Bash", "pwd && rm -rf dist", {
      allow: [],
      ask: ["Bash(rm *)"],
      deny: []
    }), { decision: "ask", rule: "Bash(rm *)" });
  });

  it("does not treat quoted command text as an executable segment", () => {
    assert.equal(decidePermission("Bash", "echo \"rm -rf dist\"", {
      allow: ["Bash"],
      ask: [],
      deny: ["Bash(rm *)"]
    }).decision, "allow");
  });

  it("keeps allow rules scoped to the complete command", () => {
    assert.equal(decidePermission("Bash", "npm test && rm -rf dist", {
      allow: ["Bash(npm test*)"],
      ask: [],
      deny: []
    }).decision, "ask");
  });

  it("fails closed when a scoped Bash deny cannot be parsed safely", () => {
    assert.deepEqual(decidePermission("Bash", "echo $(rm -rf dist)", {
      allow: ["Bash"],
      ask: [],
      deny: ["Bash(rm *)"]
    }), { decision: "deny", rule: "Bash(rm *)" });
  });

  it("does not hide a shell tool for a scoped deny rule", () => {
    assert.equal(isToolExplicitlyDenied("Bash", { deny: ["Bash(rm *)"] }), false);
    assert.equal(isToolExplicitlyDenied("Bash", { deny: ["Bash"] }), true);
    assert.equal(decidePermission("Bash", "pwd && ls -la", {
      allow: ["Bash(*)"],
      ask: [],
      deny: []
    }).decision, "allow");
  });

});

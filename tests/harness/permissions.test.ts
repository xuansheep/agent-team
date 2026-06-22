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
});

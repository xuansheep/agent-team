import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldLaunchTui } from "../src/cli/dispatch.js";

describe("CLI", () => {
  it("routes former headless commands into TUI", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "init"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "run", "delivery"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "resume", "run-id"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "status", "run-id"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "inspect", "run-id"]), true);
  });
});

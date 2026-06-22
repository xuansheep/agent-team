import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldLaunchTui, dispatchCli } from "../../src/cli/dispatch.js";

describe("CLI dispatch", () => {
  it("launches TUI when no subcommand is provided", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team"]), true);
  });

  it("keeps explicit subcommands headless", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team", "run"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "status", "run-id"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "inspect", "run-id"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "resume", "run-id"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "init"]), false);
  });

  it("calls the launcher only for the no-subcommand path", async () => {
    let launched = 0;
    await dispatchCli(["node", "agent-team"], async () => {
      launched += 1;
    });
    assert.equal(launched, 1);
  });
});

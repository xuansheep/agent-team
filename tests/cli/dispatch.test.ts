import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldLaunchTui, dispatchCli } from "../../src/cli/dispatch.js";

describe("CLI dispatch", () => {
  it("launches TUI for every invocation", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "run"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "status", "run-id"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "inspect", "run-id"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "resume", "run-id"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "init"]), true);
  });

  it("always calls the TUI launcher", async () => {
    const launched: string[] = [];
    await dispatchCli(["node", "agent-team", "run", "delivery"], async ({ cwd }) => {
      launched.push(cwd);
    });
    assert.deepEqual(launched, [process.cwd()]);
  });
});

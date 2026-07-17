import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchCli } from "../../src/cli/dispatch.js";

describe("CLI dispatch", () => {

  it("always calls the TUI launcher", async () => {
    const launched: string[] = [];
    await dispatchCli(["node", "agent-team", "run", "delivery"], async ({ cwd }) => {
      launched.push(cwd);
    });
    assert.deepEqual(launched, [process.cwd()]);
  });
});

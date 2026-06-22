import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgram } from "../src/cli/program.js";
import { shouldLaunchTui } from "../src/cli/dispatch.js";

describe("CLI", () => {
  it("registers expected commands in help", () => {
    const help = createProgram().helpInformation();

    assert.match(help, /init/);
    assert.match(help, /run/);
    assert.match(help, /resume/);
    assert.match(help, /status/);
    assert.match(help, /inspect/);
  });

  it("starts TUI only without subcommands", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "run"]), false);
  });
});

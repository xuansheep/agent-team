import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgram } from "../src/cli/program.js";

describe("CLI", () => {
  it("registers expected commands in help", () => {
    const help = createProgram().helpInformation();

    assert.match(help, /init/);
    assert.match(help, /run/);
    assert.match(help, /resume/);
    assert.match(help, /status/);
    assert.match(help, /inspect/);
  });
});

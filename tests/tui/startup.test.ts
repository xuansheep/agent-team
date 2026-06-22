import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectDefaultWorkflow } from "../../src/tui/launchTui.js";

describe("TUI startup workflow selection", () => {
  it("prefers delivery workflow", () => {
    assert.equal(selectDefaultWorkflow(["other", "delivery"]), "delivery");
  });

  it("uses the only workflow when delivery is absent", () => {
    assert.equal(selectDefaultWorkflow(["single"]), "single");
  });

  it("requires selection when multiple non-delivery workflows exist", () => {
    assert.equal(selectDefaultWorkflow(["a", "b"]), undefined);
  });
});

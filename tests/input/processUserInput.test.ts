import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processUserInput } from "../../src/input/processUserInput.js";

describe("processUserInput", () => {
  it("returns query for ordinary text", () => {
    assert.deepEqual(processUserInput("build the service"), { type: "query", text: "build the service" });
  });

  it("returns a command action for /plan and does not treat it as model input", () => {
    assert.deepEqual(processUserInput("/plan"), { type: "command", command: { type: "plan", args: [], behavior: "enter_or_request_approval" } });
  });

  it("returns empty for whitespace input", () => {
    assert.deepEqual(processUserInput("  "), { type: "empty" });
  });

  it("treats unknown slash commands as query text so the user sees normal model handling", () => {
    assert.deepEqual(processUserInput("/unknown value"), { type: "query", text: "/unknown value" });
  });
});

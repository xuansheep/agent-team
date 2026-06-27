import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandNames, parseCommandAction } from "../../src/commands/registry.js";

describe("command registry", () => {
  it("parses /plan without creating a query", () => {
    assert.deepEqual(parseCommandAction("/plan"), { type: "plan", args: [], behavior: "enter_or_request_approval" });
  });

  it("parses resume, clear, model, and permissions commands", () => {
    assert.deepEqual(parseCommandAction("/resume run-1"), { type: "resume", args: ["run-1"], runId: "run-1" });
    assert.deepEqual(parseCommandAction("/clear"), { type: "clear", args: [] });
    assert.deepEqual(parseCommandAction("/model gpt-5"), { type: "model", args: ["gpt-5"], model: "gpt-5" });
    assert.deepEqual(parseCommandAction("/permissions"), { type: "permissions", args: [] });
  });

  it("keeps unknown slash commands unhandled", () => {
    assert.equal(parseCommandAction("/run delivery"), undefined);
    assert.equal(parseCommandAction("/unknown"), undefined);
  });

  it("exposes stable command names for TUI completion", () => {
    assert.deepEqual(commandNames(), ["clear", "help", "model", "new", "permissions", "plan", "resume"]);
  });
});

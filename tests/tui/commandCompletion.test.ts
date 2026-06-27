import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySlashCommandSuggestion, slashCommandSuggestions } from "../../src/tui/commandCompletion.js";

describe("slash command completion", () => {
  const context = {
    workflows: ["delivery", "audit"],
    runs: ["run-001", "delivery-last"]
  };

  it("suggests only remaining commands with descriptions", () => {
    const suggestions = slashCommandSuggestions("/r", context);
    assert.deepEqual(suggestions.map((item) => item.value), ["/resume"]);
    assert.equal(suggestions[0]?.description, "Resume a session");
  });

  it("suggests /new and /plan commands", () => {
    assert.deepEqual(slashCommandSuggestions("/n", context).map((item) => item.value), ["/new"]);
    assert.deepEqual(slashCommandSuggestions("/pl", context).map((item) => item.value), ["/plan"]);
  });

  it("does not suggest removed /run arguments", () => {
    assert.deepEqual(slashCommandSuggestions("/run d", context), []);
    assert.deepEqual(slashCommandSuggestions("/session", context), []);
  });

  it("suggests resume arguments", () => {
    assert.deepEqual(slashCommandSuggestions("/resume del", context).map((item) => item.value), ["/resume delivery-last"]);
  });

  it("applies suggestions with the expected cursor placement", () => {
    assert.deepEqual(applySlashCommandSuggestion("/r", { value: "/resume", type: "command", label: "/resume", description: "Resume a session" }), {
      text: "/resume ",
      cursor: 8
    });
    assert.deepEqual(applySlashCommandSuggestion("/resume del", { value: "/resume delivery-last", type: "argument", label: "delivery-last", description: "session" }), {
      text: "/resume delivery-last ",
      cursor: 22
    });
  });
});

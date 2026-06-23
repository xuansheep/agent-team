import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySlashCommandSuggestion, slashCommandSuggestions } from "../../src/tui/commandCompletion.js";

describe("slash command completion", () => {
  const context = {
    workflows: ["delivery", "audit"],
    runs: ["run-001", "delivery-last"]
  };

  it("suggests commands with descriptions", () => {
    const suggestions = slashCommandSuggestions("/r", context);
    assert.deepEqual(suggestions.map((item) => item.value), ["/run", "/resume"]);
    assert.equal(suggestions[0]?.description, "Run a workflow");
  });

  it("suggests workflow and run arguments", () => {
    assert.deepEqual(slashCommandSuggestions("/run d", context).map((item) => item.value), ["/run delivery"]);
    assert.deepEqual(slashCommandSuggestions("/resume del", context).map((item) => item.value), ["/resume delivery-last"]);
  });

  it("applies suggestions with the expected cursor placement", () => {
    assert.deepEqual(applySlashCommandSuggestion("/r", { value: "/run", type: "command", label: "/run", description: "Run a workflow" }), {
      text: "/run ",
      cursor: 5
    });
    assert.deepEqual(applySlashCommandSuggestion("/run d", { value: "/run delivery", type: "argument", label: "delivery", description: "workflow" }), {
      text: "/run delivery ",
      cursor: 14
    });
  });
});

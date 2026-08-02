import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandDefinitions, parseCommandAction } from "../../src/commands/registry.js";

describe("command registry", () => {
  it("parses /plan without creating a query", () => {
    assert.deepEqual(parseCommandAction("/plan"), { type: "plan", args: [], behavior: "enter_or_show_plan" });
  });

  it("parses resume, clear, model, and permissions commands", () => {
    assert.deepEqual(parseCommandAction("/resume run-1"), { type: "resume", args: ["run-1"], runId: "run-1" });
    assert.deepEqual(parseCommandAction("/clear"), { type: "clear", args: [] });
    assert.deepEqual(parseCommandAction("/model gpt-5"), { type: "model", args: ["gpt-5"], model: "gpt-5" });
    assert.deepEqual(parseCommandAction("/permissions"), { type: "permissions", args: [] });
    assert.deepEqual(parseCommandAction("/statusline mode,workflow"), { type: "statusline", args: ["mode,workflow"] });
    assert.deepEqual(parseCommandAction("/terminal-setup"), { type: "terminal-setup", args: [] });
  });

  it("parses skills and mcp commands", () => {
    assert.deepEqual(parseCommandAction("/skills"), { type: "skills", args: [] });
    assert.deepEqual(parseCommandAction("/mcp"), { type: "mcp", args: [] });
    assert.deepEqual(parseCommandAction("/mcp enable docs"), { type: "mcp", args: ["enable", "docs"], subcommand: "enable", serverName: "docs" });
    assert.deepEqual(parseCommandAction("/mcp disable"), { type: "mcp", args: ["disable"], subcommand: "disable", serverName: undefined });
    assert.deepEqual(parseCommandAction("/mcp reconnect docs"), { type: "mcp", args: ["reconnect", "docs"], subcommand: "reconnect", serverName: "docs" });
  });

  it("keeps unknown slash commands unhandled", () => {
    assert.equal(parseCommandAction("/run delivery"), undefined);
    assert.equal(parseCommandAction("/diagnostics"), undefined);
    assert.equal(parseCommandAction("/unknown"), undefined);
  });

  it("exposes stable command names for TUI completion", () => {
    assert.deepEqual(commandDefinitions().map((command) => command.name).sort(), ["clear", "help", "mcp", "model", "new", "permissions", "plan", "resume", "skills", "statusline", "terminal-setup"]);
  });

  it("documents /plan open in the command hint", () => {
    assert.equal(commandDefinitions().find((command) => command.name === "plan")?.argumentHint, "[open|<description>]");
  });

  it("exposes /statusline as an interactive command without argument hints", () => {
    const definition = commandDefinitions().find((command) => command.name === "statusline");
    assert.equal(definition?.description, "Configure bottom statusline elements");
    assert.equal(definition?.argumentHint, undefined);
  });

  it("documents /mcp list and actions", () => {
    const definition = commandDefinitions().find((command) => command.name === "mcp");
    assert.equal(definition?.description, "List and manage MCP servers");
    assert.equal(definition?.argumentHint, "[enable|disable|reconnect [server-name]]");
  });
});

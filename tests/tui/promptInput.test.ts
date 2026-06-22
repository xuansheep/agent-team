import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuffer, insertText, insertNewline, backspace, moveLeft, moveRight } from "../../src/tui/components/PromptInput/usePromptBuffer.js";
import { createHistory, pushHistory, previousHistory, nextHistory } from "../../src/tui/components/PromptInput/usePromptHistory.js";
import { resolvePromptKey } from "../../src/tui/components/PromptInput/keybindings.js";
import { slashCommandSuggestions } from "../../src/tui/components/PromptInput/usePromptSuggestions.js";
import { parseSlashCommand } from "../../src/tui/commands.js";

describe("PromptInput core logic", () => {
  it("edits a multiline prompt buffer", () => {
    let buffer = createPromptBuffer();
    buffer = insertText(buffer, "Build TUI");
    buffer = insertNewline(buffer);
    buffer = insertText(buffer, "with permissions");
    assert.equal(buffer.text, "Build TUI\nwith permissions");

    buffer = moveLeft(buffer);
    assert.equal(buffer.cursor, buffer.text.length - 1);

    buffer = moveRight(buffer);
    buffer = backspace(buffer);
    assert.equal(buffer.text, "Build TUI\nwith permission");

    buffer = moveRight(buffer);
    assert.equal(buffer.cursor, buffer.text.length);
  });

  it("navigates prompt history", () => {
    let history = createHistory();
    history = pushHistory(history, "first");
    history = pushHistory(history, "second");

    const previous = previousHistory(history);
    assert.equal(previous.value, "second");

    const earlier = previousHistory(previous.history);
    assert.equal(earlier.value, "first");

    const next = nextHistory(earlier.history);
    assert.equal(next.value, "second");
  });

  it("parses slash commands", () => {
    assert.deepEqual(parseSlashCommand("/run delivery"), { name: "run", args: ["delivery"] });
    assert.deepEqual(parseSlashCommand("normal text"), undefined);
  });

  it("maps terminal keys to prompt actions", () => {
    assert.equal(resolvePromptKey("", { return: true }), "submit");
    assert.equal(resolvePromptKey("", { return: true, meta: true }), "newline");
    assert.equal(resolvePromptKey("\n", { ctrl: true }), "newline");
    assert.equal(resolvePromptKey("", { upArrow: true }), "history_previous");
  });

  it("suggests slash commands and workflow targets", () => {
    assert.deepEqual(slashCommandSuggestions("/r", ["delivery"]), ["/run", "/resume", "/run delivery"]);
    assert.deepEqual(slashCommandSuggestions("plain", ["delivery"]), []);
  });
});

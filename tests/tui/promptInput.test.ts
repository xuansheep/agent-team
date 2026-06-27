import { describe, it } from "node:test";

import assert from "node:assert/strict";

import {

  backspace,

  clearBuffer,

  createPromptBuffer,

  deleteCharacter,

  deletePreviousWord,

  deleteToEndOfLine,

  deleteToStartOfLine,

  insertNewline,

  insertText,

  moveEnd,

  moveHome,

  moveLeft,

  moveRight

} from "../../src/tui/components/PromptInput/usePromptBuffer.js";

import { createHistory, nextHistory, previousHistory, pushHistory } from "../../src/tui/components/PromptInput/usePromptHistory.js";

import { resolvePromptKey, resolveRawPromptKey } from "../../src/tui/components/PromptInput/keybindings.js";

import { applyPromptNativeCursor, promptCursorPosition, schedulePromptCursorMove } from "../../src/tui/components/PromptInput/PromptInputCursor.js";

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



  it("supports shell-style line editing commands", () => {

    let buffer = createPromptBuffer("alpha beta gamma");

    for (let i = 0; i < 5; i++) buffer = moveLeft(buffer);

    assert.equal(buffer.cursor, 11);



    buffer = deletePreviousWord(buffer);

    assert.deepEqual(buffer, { text: "alpha gamma", cursor: 6, selectionAnchor: undefined });



    buffer = moveHome(buffer);

    assert.equal(buffer.cursor, 0);



    buffer = moveEnd(buffer);

    assert.equal(buffer.cursor, "alpha gamma".length);



    buffer = moveLeft(moveLeft(moveLeft(moveLeft(moveLeft(buffer)))));

    buffer = deleteToEndOfLine(buffer);

    assert.deepEqual(buffer, { text: "alpha ", cursor: 6, selectionAnchor: undefined });



    buffer = insertText(buffer, "beta");

    buffer = deleteToStartOfLine(buffer);

    assert.deepEqual(buffer, { text: "", cursor: 0, selectionAnchor: undefined });

  });



  it("deletes at the cursor and clears the buffer", () => {

    let buffer = createPromptBuffer("abc");

    buffer = moveLeft(buffer);

    buffer = deleteCharacter(buffer);

    assert.equal(buffer.text, "ab");

    assert.equal(buffer.cursor, 2);



    buffer = clearBuffer();

    assert.deepEqual(buffer, { text: "", cursor: 0 });

  });



  it("moves and deletes by grapheme clusters", () => {

    let buffer = createPromptBuffer("你🙂e\u0301");

    buffer = moveLeft(buffer);

    assert.equal(buffer.cursor, "你🙂".length);



    buffer = backspace(buffer);

    assert.equal(buffer.text, "你e\u0301");

    assert.equal(buffer.cursor, "你".length);



    buffer = moveRight(buffer);

    buffer = deleteCharacter(buffer);

    assert.equal(buffer.text, "你e\u0301");

  });



  it("navigates prompt history and returns to a blank input after the latest entry", () => {

    let history = createHistory();

    history = pushHistory(history, "first");

    history = pushHistory(history, "second");



    const previous = previousHistory(history);

    assert.equal(previous.value, "second");



    const earlier = previousHistory(previous.history);

    assert.equal(earlier.value, "first");



    const next = nextHistory(earlier.history);

    assert.equal(next.value, "second");



    const blank = nextHistory(next.history);

    assert.equal(blank.value, "");

    assert.equal(blank.history.index, undefined);

  });



  it("parses slash commands", () => {

    assert.deepEqual(parseSlashCommand("/run delivery"), undefined);
    assert.deepEqual(parseSlashCommand("/resume run-1"), { name: "resume", args: ["run-1"] });

    assert.deepEqual(parseSlashCommand("/new"), { name: "new", args: [] });
    assert.deepEqual(parseSlashCommand("/plan"), { name: "plan", args: [] });

    assert.deepEqual(parseSlashCommand("normal text"), undefined);

  });



  it("maps terminal keys to prompt actions", () => {

    assert.equal(resolvePromptKey("", { return: true }), "submit");

    assert.equal(resolvePromptKey("", { return: true, meta: true }), "newline");

    assert.equal(resolvePromptKey("\n", { ctrl: true }), "newline");

    assert.equal(resolvePromptKey("", { upArrow: true }), "history_previous");

    assert.equal(resolvePromptKey("", { downArrow: true }), "history_next");

    assert.equal(resolvePromptKey("", { delete: true }), "none");

    assert.equal(resolvePromptKey("a", { ctrl: true }), "home");

    assert.equal(resolvePromptKey("e", { ctrl: true }), "end");

    assert.equal(resolvePromptKey("u", { ctrl: true }), "delete_to_start");

    assert.equal(resolvePromptKey("k", { ctrl: true }), "delete_to_end");

    assert.equal(resolvePromptKey("w", { ctrl: true }), "delete_previous_word");

    assert.equal(resolvePromptKey("c", { ctrl: true }), "none");

    assert.equal(resolvePromptKey("o", { ctrl: true }), "none");

  });







  it("ignores submit and history keys while permission choices are active", () => {

    assert.equal(resolvePromptKey("", { return: true }, "permission"), "none");

    assert.equal(resolvePromptKey("", { upArrow: true }, "permission"), "none");

    assert.equal(resolvePromptKey("", { downArrow: true }, "permission"), "none");

    assert.equal(resolvePromptKey("o", { ctrl: true }, "permission"), "none");

    assert.equal(resolvePromptKey("", { escape: true }, "permission"), "cancel");

  });









  it("ignores terminal mouse reporting sequences", () => {

    assert.equal(resolvePromptKey("[<0;10;5M", {}), "ignore");

    assert.equal(resolvePromptKey("[<0;10;5m", {}), "ignore");

    assert.equal(resolvePromptKey("[<64;10;5M", {}), "ignore");

    assert.equal(resolvePromptKey("[<64;10;5M[<65;10;5M", {}), "ignore");

    assert.equal(resolvePromptKey("[<", {}), "ignore");

    assert.equal(resolvePromptKey("<64;10;5M", {}), "ignore");

    assert.equal(resolveRawPromptKey("[<65;10;5M"), "ignore");

    assert.equal(resolveRawPromptKey("[<0;10;5M[<0;10;5m"), "ignore");

  });



  it("maps raw terminal sequences that Ink does not expose accurately", () => {

    assert.equal(resolveRawPromptKey("\u007f"), "backspace");

    assert.equal(resolveRawPromptKey("\u001b[3~"), "delete");

    assert.equal(resolveRawPromptKey("\u001b[H"), "home");

    assert.equal(resolveRawPromptKey("\u001bOH"), "home");

    assert.equal(resolveRawPromptKey("\u001b[1~"), "home");

    assert.equal(resolveRawPromptKey("\u001b[F"), "end");

    assert.equal(resolveRawPromptKey("\u001bOF"), "end");

    assert.equal(resolveRawPromptKey("\u001b[4~"), "end");

    assert.equal(resolveRawPromptKey("x"), "none");

  });





  it("calculates the real terminal cursor position for IME candidate placement", () => {

    assert.deepEqual(

      promptCursorPosition({

        terminalRows: 24,

        mode: "input",

        text: "abc",

        cursor: 2,

        suggestions: 0,

        queued: 0,

        hasStash: false,

        history: 0

      }),

      { x: 11, y: 21 }

    );



    assert.deepEqual(

      promptCursorPosition({

        terminalRows: 24,

        mode: "question",

        text: "第一行\n第二行",

        cursor: "第一行\n第".length,

        suggestions: 1,

        queued: 2,

        hasStash: true,

        history: 3

      }),

      { x: 14, y: 18 }

    );

  });







  it("uses a fixed prompt origin when calculating cursor position", () => {

    assert.deepEqual(

      promptCursorPosition({

        terminalRows: 40,

        promptTop: 30,

        mode: "input",

        text: "abc",

        cursor: 2,

        suggestions: 0,

        queued: 0,

        hasStash: false,

        history: 0

      }),

      { x: 11, y: 30 }

    );

  });



  it("keeps the cursor on the prompt input row after history is added", () => {

    assert.deepEqual(

      promptCursorPosition({

        terminalRows: 40,

        promptTop: 36,

        mode: "input",

        text: "",

        cursor: 0,

        suggestions: 0,

        queued: 0,

        hasStash: false,

        history: 1

      }),

      { x: 9, y: 36 }

    );

  });



  it("schedules cursor movement after the current render pass", () => {

    const writes: string[] = [];

    const callbacks: Array<() => void> = [];

    const cleared: unknown[] = [];

    const cancel = schedulePromptCursorMove(

      { isTTY: true, write: (data: string) => writes.push(data) },

      { x: 9, y: 36 },

      (callback) => {

        callbacks.push(callback);

        return "timer-1" as unknown as ReturnType<typeof setTimeout>;

      },

      (timer) => cleared.push(timer)

    );



    assert.deepEqual(writes, []);

    assert.equal(callbacks.length, 1);

    callbacks[0]?.();

    assert.deepEqual(writes, ["\u001b[?25h\u001b[37;10H"]);



    cancel();

    assert.deepEqual(cleared, ["timer-1"]);

  });



  it("sets and restores a native blinking bar cursor", () => {

    const writes: string[] = [];

    const cleanup = applyPromptNativeCursor({ isTTY: true, write: (data: string) => writes.push(data) });



    assert.deepEqual(writes, ["\u001b[?25h\u001b[5 q"]);



    cleanup();

    assert.deepEqual(writes, ["\u001b[?25h\u001b[5 q", "\u001b[0 q"]);

  });



  it("suggests slash commands and workflow targets", () => {

    assert.deepEqual(slashCommandSuggestions("/r", ["delivery"]), ["/resume"]);

    assert.deepEqual(slashCommandSuggestions("/n", ["delivery"]), ["/new"]);
    assert.deepEqual(slashCommandSuggestions("/p", ["delivery"]), ["/plan", "/permissions"]);

    assert.deepEqual(slashCommandSuggestions("plain", ["delivery"]), []);

  });

});


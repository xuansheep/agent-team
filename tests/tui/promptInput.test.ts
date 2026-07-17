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
  isCursorOnFirstLine,
  isCursorOnLastLine,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp
} from "../../src/tui/components/PromptInput/usePromptBuffer.js";
import { createHistory, nextHistory, previousHistory, pushHistory } from "../../src/tui/components/PromptInput/usePromptHistory.js";
import { applyPromptNativeCursor, promptCursorPosition, schedulePromptCursorMove } from "../../src/tui/components/PromptInput/PromptInputCursor.js";

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

  it("moves vertically within multiline input and clamps to the destination line", () => {
    let buffer = createPromptBuffer("abcd\nx\nxyz");
    buffer = { ...buffer, cursor: "abcd\nx".length };
    assert.equal(isCursorOnFirstLine(buffer), false);
    buffer = moveUp(buffer);
    assert.equal(buffer.cursor, 1);
    assert.equal(isCursorOnFirstLine(buffer), true);
    buffer = moveDown(buffer);
    assert.equal(buffer.cursor, "abcd\nx".length);
    buffer = moveDown(buffer);
    assert.equal(buffer.cursor, "abcd\nx\nx".length);
    assert.equal(isCursorOnLastLine(buffer), true);
    const unicode = moveUp(createPromptBuffer("\ud83d\ude42b\nx"));
    assert.equal(unicode.cursor, "\ud83d\ude42".length);
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

  it("navigates prompt history and restores the draft after the latest entry", () => {
    let history = createHistory(["first", "second"]);
    history = pushHistory(history, "second");

    const previous = previousHistory(history, "draft text");
    assert.equal(previous.value, "second");

    const earlier = previousHistory(previous.history);
    assert.equal(earlier.value, "second");

    const oldest = previousHistory(earlier.history);
    assert.equal(oldest.value, "first");

    const next = nextHistory(oldest.history);
    assert.equal(next.value, "second");

    const duplicate = nextHistory(next.history);
    assert.equal(duplicate.value, "second");

    const draft = nextHistory(duplicate.history);
    assert.equal(draft.value, "draft text");
    assert.equal(draft.history.index, undefined);
    assert.equal(draft.history.draft, undefined);
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
      { x: 4, y: 21 }
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
      { x: 4, y: 18 }
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
      { x: 4, y: 30 }
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
      { x: 2, y: 36 }
    );
  });

  it("schedules cursor movement after the current render pass", () => {
    const writes: string[] = [];
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const cancel = schedulePromptCursorMove(
      { isTTY: true, write: (data: string) => writes.push(data) },
      { x: 2, y: 36 },
      (callback) => {
        callbacks.push(callback);
        return "timer-1" as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => cleared.push(timer)
    );

    assert.deepEqual(writes, []);
    assert.equal(callbacks.length, 1);
    callbacks[0]?.();
    assert.deepEqual(writes, ["\u001b[?25h\u001b[37;3H"]);

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

});

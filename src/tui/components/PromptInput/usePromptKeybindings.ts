import { useInput, useStdin } from "../../ink.js";
import type { Key } from "../../../ink/events/input-event.js";
import { applySlashCommandSuggestion, SlashCommandSuggestion } from "../../commandCompletion.js";
import { parseSlashCommand } from "../../commands.js";
import { ensureRefableStdin } from "../../inkStdin.js";
import { TuiInputEvent, TuiInputKey } from "../../input/types.js";
import {
  backspace,
  clearBuffer,
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
} from "./usePromptBuffer.js";
import { nextHistory, previousHistory, pushHistory } from "./usePromptHistory.js";
import { PromptBuffer, PromptHistory, PromptInputEvent, PromptInputMode } from "./types.js";

export function usePromptKeybindings(input: {
  mode: PromptInputMode;
  buffer: PromptBuffer;
  history: PromptHistory;
  isLoading: boolean;
  suggestions: SlashCommandSuggestion[];
  selectedSuggestion: number;
  onSelectedSuggestion: (index: number) => void;
  onBuffer: (buffer: PromptBuffer) => void;
  onHistory: (history: PromptHistory) => void;
  onEvent: (event: PromptInputEvent) => void;
}) {
  const { stdin } = useStdin();
  ensureRefableStdin(stdin);

  useInput((value, key, event) => {
    if (event.keypress.isPasted) {
      handleInputEvent({ type: "paste", text: value }, input);
      return;
    }

    handleInputEvent({ type: "key", input: value, key: toTuiInputKey(key, value) }, input);
  });
}

function toTuiInputKey(key: Key, input: string): TuiInputKey {
  return {
    upArrow: key.upArrow,
    downArrow: key.downArrow,
    leftArrow: key.leftArrow,
    rightArrow: key.rightArrow,
    pageUp: key.pageUp,
    pageDown: key.pageDown,
    wheelUp: key.wheelUp,
    wheelDown: key.wheelDown,
    home: key.home,
    end: key.end,
    return: key.return || input === "\r" || input === "\n",
    escape: key.escape,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
    tab: key.tab,
    backspace: key.backspace,
    delete: key.delete
  };
}

function handleInputEvent(event: TuiInputEvent, input: Parameters<typeof usePromptKeybindings>[0]) {
  if (event.type === "mouse") return;
  if (event.type === "paste") {
    if (modeAcceptsText(input.mode)) input.onBuffer(insertText(input.buffer, event.text));
    return;
  }

  const { key } = event;
  if (key.ctrl && event.input === "o") {
    input.onEvent({ type: "toggle_log_detail" });
    return;
  }

  if (input.suggestions.length > 0) {
    if (key.upArrow) {
      input.onSelectedSuggestion(wrapIndex(input.selectedSuggestion - 1, input.suggestions.length));
      return;
    }
    if (key.downArrow) {
      input.onSelectedSuggestion(wrapIndex(input.selectedSuggestion + 1, input.suggestions.length));
      return;
    }
    if (key.tab || key.return) {
      applySuggestion(input);
      return;
    }
    if (key.escape) {
      input.onSelectedSuggestion(-1);
      return;
    }
  }

  if (key.return) {
    submit(input);
    return;
  }

  const action = keyAction(event.input, key, input.mode);
  if (action(input)) return;

  if (event.input && modeAcceptsText(input.mode)) input.onBuffer(insertText(input.buffer, event.input));
}

function submit(input: Parameters<typeof usePromptKeybindings>[0]) {
  const text = input.buffer.text.trim();
  if (!text || !modeAcceptsSubmit(input.mode)) return;

  const command = parseSlashCommand(text);
  input.onHistory(pushHistory(input.history, text));
  input.onBuffer(clearBuffer());
  if (input.isLoading) {
    input.onEvent({ type: "queue", text });
  } else if (command) {
    input.onEvent({ type: "command", name: command.name, args: command.args });
  } else {
    input.onEvent({ type: "submit", text });
  }
}

function applySuggestion(input: Parameters<typeof usePromptKeybindings>[0]) {
  const suggestion = input.suggestions[Math.max(0, input.selectedSuggestion)];
  if (!suggestion) return;
  input.onBuffer(applySlashCommandSuggestion(input.buffer.text, suggestion));
  input.onSelectedSuggestion(0);
}

function keyAction(inputText: string, key: TuiInputKey, mode: PromptInputMode): (input: Parameters<typeof usePromptKeybindings>[0]) => boolean {
  return (input) => {
    if (mode === "permission" || mode === "waiting_plan_review" || mode === "confirm_interrupt") {
      if (key.escape) input.onEvent({ type: "cancel" });
      return true;
    }
    if (key.ctrl) {
      if (inputText === "a") input.onBuffer(moveHome(input.buffer));
      else if (inputText === "e") input.onBuffer(moveEnd(input.buffer));
      else if (inputText === "u") input.onBuffer(deleteToStartOfLine(input.buffer));
      else if (inputText === "k") input.onBuffer(deleteToEndOfLine(input.buffer));
      else if (inputText === "w") input.onBuffer(deletePreviousWord(input.buffer));
      else if (inputText === "c") input.onBuffer(clearBuffer());
      else return false;
      return true;
    }
    if (key.escape) {
      input.onEvent({ type: "cancel" });
      return true;
    }
    if (key.backspace) input.onBuffer(backspace(input.buffer));
    else if (key.delete) input.onBuffer(deleteCharacter(input.buffer));
    else if (key.leftArrow) input.onBuffer(moveLeft(input.buffer));
    else if (key.rightArrow) input.onBuffer(moveRight(input.buffer));
    else if (key.home) input.onBuffer(moveHome(input.buffer));
    else if (key.end) input.onBuffer(moveEnd(input.buffer));
    else if (key.upArrow) {
      const previous = previousHistory(input.history);
      input.onHistory(previous.history);
      input.onBuffer({ text: previous.value, cursor: previous.value.length });
    } else if (key.downArrow) {
      const next = nextHistory(input.history);
      input.onHistory(next.history);
      input.onBuffer({ text: next.value, cursor: next.value.length });
    } else return false;
    return true;
  };
}

function modeAcceptsText(mode: PromptInputMode): boolean {
  return mode === "input" || mode === "running" || mode === "question";
}

function modeAcceptsSubmit(mode: PromptInputMode): boolean {
  return mode === "input" || mode === "running" || mode === "question";
}

function wrapIndex(index: number, length: number): number {
  return (index + length) % length;
}

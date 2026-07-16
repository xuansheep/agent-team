import { useRef } from "react";
import { useInput, useStdin } from "../../ink.js";
import type { Key } from "../../../ink/events/input-event.js";
import { applySlashCommandSuggestion, SlashCommandSuggestion } from "../../commandCompletion.js";
import { processUserInput } from "../../../input/processUserInput.js";
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
  isCursorOnFirstLine,
  isCursorOnLastLine,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp
} from "./usePromptBuffer.js";
import { nextHistory, previousHistory, pushHistory } from "./usePromptHistory.js";
import { PromptBuffer, PromptHistory, PromptInputEvent, PromptInputImageAttachment, PromptInputMode } from "./types.js";

type PromptKeybindingInput = {
  mode: PromptInputMode;
  buffer: PromptBuffer;
  history: PromptHistory;
  isLoading: boolean;
  isActive?: boolean;
  textInputBlocked?: boolean;
  imageAttachments?: PromptInputImageAttachment[];
  skillNames: string[];
  suggestions: SlashCommandSuggestion[];
  selectedSuggestion: number;
  onSelectedSuggestion: (index: number) => void;
  onBuffer: (buffer: PromptBuffer) => void;
  onHistory: (history: PromptHistory) => void;
  onRecordHistory?: (value: string) => void;
  onEvent: (event: PromptInputEvent) => void;
  onImagePaste?: (image: PromptInputImageAttachment) => void;
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: PromptInputImageAttachment[] }>;
  editText?: (text: string) => Promise<{ content: string | null; error?: string }> | { content: string | null; error?: string };
};

export function usePromptKeybindings(input: PromptKeybindingInput) {
  const { stdin } = useStdin();
  ensureRefableStdin(stdin);
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  useInput((value, key, event) => {
    const current = latestInputRef.current;
    if (current.isActive === false) return;

    const syncedInput: PromptKeybindingInput = {
      ...current,
      onBuffer: (buffer) => {
        latestInputRef.current = { ...latestInputRef.current, buffer };
        current.onBuffer(buffer);
      },
      onHistory: (history) => {
        latestInputRef.current = { ...latestInputRef.current, history };
        current.onHistory(history);
      },
      onSelectedSuggestion: (selectedSuggestion) => {
        latestInputRef.current = { ...latestInputRef.current, selectedSuggestion };
        current.onSelectedSuggestion(selectedSuggestion);
      }
    };

    if (event.keypress.isPasted) {
      handleInputEvent({ type: "paste", text: value }, syncedInput);
      return;
    }

    const inputKey = toTuiInputKey(key, value);
    const promptSubmit = inputKey.return && !inputKey.shift && !inputKey.ctrl && !inputKey.meta
      && (current.buffer.text.trim() || current.imageAttachments?.length) && modeAcceptsSubmit(current.mode);
    handleInputEvent({ type: "key", input: value, key: inputKey }, syncedInput);
    if (promptSubmit) event.stopImmediatePropagation();
  }, { isActive: input.isActive !== false });
}

function toTuiInputKey(key: Key, input: string): TuiInputKey {
  return {
    upArrow: key.upArrow || input === "\u001b[A",
    downArrow: key.downArrow || input === "\u001b[B",
    leftArrow: key.leftArrow || input === "\u001b[D",
    rightArrow: key.rightArrow || input === "\u001b[C",
    pageUp: key.pageUp,
    pageDown: key.pageDown,
    wheelUp: key.wheelUp,
    wheelDown: key.wheelDown,
    home: key.home || input === "\u001b[H" || input === "\u001bOH" || input === "\u001b[1~" || input === "\u001b[7~",
    end: key.end || input === "\u001b[F" || input === "\u001bOF" || input === "\u001b[4~" || input === "\u001b[8~",
    return: key.return || input === "\r" || input === "\n",
    escape: key.escape,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
    tab: key.tab,
    ...(input === "\u001b[Z" ? { shift: true, tab: true } : {}),
    backspace: key.backspace || input === "\u007f",
    delete: key.delete || input === "\u001b[3~"
  };
}

function handleInputEvent(event: TuiInputEvent, input: PromptKeybindingInput) {
  if (event.type === "mouse") return;
  if (event.type === "paste") {
    if (!input.textInputBlocked && modeAcceptsText(input.mode)) {
      if (input.resolveImagePaste) void pasteWithImages(event.text, input);
      else input.onBuffer(insertText(input.buffer, event.text));
    }
    return;
  }

  const { key } = event;
  if (key.shift && key.tab) {
    input.onEvent({ type: "cycle_mode" });
    return;
  }
  if (input.textInputBlocked) {
    if (event.input === "\u0007" || (key.ctrl && event.input === "g")) input.onEvent({ type: "external_editor" });
    return;
  }
  if (key.return && key.meta) return;
  if (key.return && (key.shift || key.ctrl)) {
    if (modeAcceptsText(input.mode)) input.onBuffer(insertNewline(input.buffer));
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
    if (key.return && (isExactSuggestion(input) || hasSlashCommandArguments(input.buffer.text))) {
      submit(input);
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
  if (event.input === "\u0007" || (key.ctrl && event.input === "g")) {
    if (input.editText) {
      void editPromptBuffer(input);
    } else {
      input.onEvent({ type: "external_editor" });
    }
    return;
  }

  const action = keyAction(event.input, key, input.mode);
  if (action(input)) return;

  if (event.input && modeAcceptsText(input.mode)) input.onBuffer(insertText(input.buffer, event.input));
}

async function editPromptBuffer(input: PromptKeybindingInput) {
  try {
    const result = await input.editText?.(input.buffer.text);
    if (!result) return;
    if (result.error) {
      input.onEvent({ type: "external_editor_error", error: result.error });
      return;
    }
    if (result.content !== null) {
      input.onBuffer({ text: result.content, cursor: result.content.length });
    }
  } catch (error) {
    input.onEvent({ type: "external_editor_error", error: error instanceof Error ? error.message : String(error) });
  }
}

async function pasteWithImages(text: string, input: PromptKeybindingInput) {
  const parsed = await input.resolveImagePaste?.(text);
  if (!parsed) return;
  for (const image of parsed.images) input.onImagePaste?.(image);
  if (parsed.text) input.onBuffer(insertText(input.buffer, parsed.text));
}

function submit(input: PromptKeybindingInput) {
  const text = input.buffer.text.trim();
  const images = input.imageAttachments ?? [];
  if ((!text && !images.length) || !modeAcceptsSubmit(input.mode)) return;

  const processed = processUserInput(text);
  input.onHistory(pushHistory(input.history, text));
  input.onRecordHistory?.(text);
  input.onBuffer(clearBuffer());
  if (input.isLoading) {
    input.onEvent({ type: "queue", text, ...(images.length ? { images } : {}) });
  } else if (processed.type === "command") {
    input.onEvent({ type: "command", name: processed.command.type, args: processed.command.args });
  } else if (processed.type === "query" && text.startsWith("/")) {
    const [name, ...args] = text.slice(1).split(/\s+/);
    if (name && input.skillNames.includes(name)) input.onEvent({ type: "command", name, args });
    else input.onEvent({ type: "submit", text, ...(images.length ? { images } : {}) });
  } else if (images.length && processed.type === "empty") {
    input.onEvent({ type: "submit", text, images });
  } else if (processed.type === "query") {
    input.onEvent({ type: "submit", text: processed.text, ...(images.length ? { images } : {}) });
  }

}

function applySuggestion(input: PromptKeybindingInput) {
  const suggestion = input.suggestions[Math.max(0, input.selectedSuggestion)];
  if (!suggestion) return;
  input.onBuffer(applySlashCommandSuggestion(input.buffer.text, suggestion));
  input.onSelectedSuggestion(0);
}

function isExactSuggestion(input: PromptKeybindingInput): boolean {
  const suggestion = input.suggestions[Math.max(0, input.selectedSuggestion)];
  return suggestion?.value.toLowerCase() === input.buffer.text.trim().toLowerCase();
}

function hasSlashCommandArguments(text: string): boolean {
  return /^\/\S+\s+\S/.test(text.trim());
}

function keyAction(inputText: string, key: TuiInputKey, mode: PromptInputMode): (input: PromptKeybindingInput) => boolean {
  return (input) => {
    if (mode === "permission" || mode === "confirm_interrupt") {
      if (key.escape) input.onEvent({ type: "cancel" });
      return true;
    }
    if (key.ctrl) {
      if (inputText === "a") input.onBuffer(moveHome(input.buffer));
      else if (inputText === "e") input.onBuffer(moveEnd(input.buffer));
      else if (inputText === "u") input.onBuffer(deleteToStartOfLine(input.buffer));
      else if (inputText === "k") input.onBuffer(deleteToEndOfLine(input.buffer));
      else if (inputText === "w") input.onBuffer(deletePreviousWord(input.buffer));
      else if (inputText === "c") return true;
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
      if (!isCursorOnFirstLine(input.buffer)) {
        input.onBuffer(moveUp(input.buffer));
      } else {
        const previous = previousHistory(input.history, input.buffer.text);
        input.onHistory(previous.history);
        input.onBuffer({ text: previous.value, cursor: previous.value.length });
      }
    } else if (key.downArrow) {
      if (!isCursorOnLastLine(input.buffer)) {
        input.onBuffer(moveDown(input.buffer));
      } else {
        const next = nextHistory(input.history);
        input.onHistory(next.history);
        input.onBuffer({ text: next.value, cursor: next.value.length });
      }
    } else return false;
    return true;
  };
}

function modeAcceptsText(mode: PromptInputMode): boolean {
  return mode === "input" || mode === "running" || mode === "question" || mode === "waiting_plan_review";
}

function modeAcceptsSubmit(mode: PromptInputMode): boolean {
  return mode === "input" || mode === "running" || mode === "question" || mode === "waiting_plan_review";
}

function wrapIndex(index: number, length: number): number {
  return (index + length) % length;
}

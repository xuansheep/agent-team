import { PromptBuffer } from "./types.js";

export function createPromptBuffer(text = ""): PromptBuffer {
  return { text, cursor: text.length };
}

export function insertText(buffer: PromptBuffer, text: string): PromptBuffer {
  return replaceRange(buffer, buffer.cursor, buffer.cursor, text);
}

export function insertNewline(buffer: PromptBuffer): PromptBuffer {
  return insertText(buffer, "\n");
}

export function backspace(buffer: PromptBuffer): PromptBuffer {
  if (buffer.cursor === 0) return buffer;
  return replaceRange(buffer, buffer.cursor - 1, buffer.cursor, "");
}

export function moveLeft(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: Math.max(0, buffer.cursor - 1), selectionAnchor: undefined };
}

export function moveRight(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: Math.min(buffer.text.length, buffer.cursor + 1), selectionAnchor: undefined };
}

export function clearBuffer(): PromptBuffer {
  return createPromptBuffer();
}

function replaceRange(buffer: PromptBuffer, start: number, end: number, value: string): PromptBuffer {
  const text = `${buffer.text.slice(0, start)}${value}${buffer.text.slice(end)}`;
  return { text, cursor: start + value.length, selectionAnchor: undefined };
}

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
  const start = previousGraphemeOffset(buffer.text, buffer.cursor);
  return replaceRange(buffer, start, buffer.cursor, "");
}

export function deleteCharacter(buffer: PromptBuffer): PromptBuffer {
  if (buffer.cursor >= buffer.text.length) return buffer;
  const end = nextGraphemeOffset(buffer.text, buffer.cursor);
  return replaceRange(buffer, buffer.cursor, end, "");
}

export function deleteToStartOfLine(buffer: PromptBuffer): PromptBuffer {
  return replaceRange(buffer, lineStart(buffer), buffer.cursor, "");
}

export function deleteToEndOfLine(buffer: PromptBuffer): PromptBuffer {
  return replaceRange(buffer, buffer.cursor, lineEnd(buffer), "");
}

export function deletePreviousWord(buffer: PromptBuffer): PromptBuffer {
  if (buffer.cursor === 0) return buffer;
  let start = buffer.cursor;
  while (start > 0 && /\s/.test(previousGrapheme(buffer.text, start))) start = previousGraphemeOffset(buffer.text, start);
  while (start > 0 && !/\s/.test(previousGrapheme(buffer.text, start))) start = previousGraphemeOffset(buffer.text, start);
  return replaceRange(buffer, start, buffer.cursor, "");
}

export function moveLeft(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: previousGraphemeOffset(buffer.text, buffer.cursor), selectionAnchor: undefined };
}

export function moveRight(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: nextGraphemeOffset(buffer.text, buffer.cursor), selectionAnchor: undefined };
}

export function isCursorOnFirstLine(buffer: PromptBuffer): boolean {
  return lineStart(buffer) === 0;
}

export function isCursorOnLastLine(buffer: PromptBuffer): boolean {
  return lineEnd(buffer) === buffer.text.length;
}

export function moveUp(buffer: PromptBuffer): PromptBuffer {
  const currentStart = lineStart(buffer);
  if (currentStart === 0) return buffer;
  const previousEnd = currentStart - 1;
  const previousStart = buffer.text.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
  return {
    ...buffer,
    cursor: cursorAtSameGraphemeColumn(buffer.text, currentStart, buffer.cursor, previousStart, previousEnd),
    selectionAnchor: undefined
  };
}

export function moveDown(buffer: PromptBuffer): PromptBuffer {
  const currentStart = lineStart(buffer);
  const currentEnd = lineEnd(buffer);
  if (currentEnd === buffer.text.length) return buffer;
  const nextStart = currentEnd + 1;
  const nextBreak = buffer.text.indexOf("\n", nextStart);
  const nextEnd = nextBreak === -1 ? buffer.text.length : nextBreak;
  return {
    ...buffer,
    cursor: cursorAtSameGraphemeColumn(buffer.text, currentStart, buffer.cursor, nextStart, nextEnd),
    selectionAnchor: undefined
  };
}

export function moveHome(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: lineStart(buffer), selectionAnchor: undefined };
}

export function moveEnd(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: lineEnd(buffer), selectionAnchor: undefined };
}

export function clearBuffer(): PromptBuffer {
  return createPromptBuffer();
}

function lineStart(buffer: PromptBuffer): number {
  return buffer.text.lastIndexOf("\n", Math.max(0, buffer.cursor - 1)) + 1;
}

function lineEnd(buffer: PromptBuffer): number {
  const index = buffer.text.indexOf("\n", buffer.cursor);
  return index === -1 ? buffer.text.length : index;
}

function cursorAtSameGraphemeColumn(text: string, currentStart: number, cursor: number, targetStart: number, targetEnd: number): number {
  const currentColumn = graphemeBoundaries(text.slice(currentStart, cursor)).length - 1;
  const targetBoundaries = graphemeBoundaries(text.slice(targetStart, targetEnd));
  return targetStart + (targetBoundaries[Math.min(currentColumn, targetBoundaries.length - 1)] ?? 0);
}

function replaceRange(buffer: PromptBuffer, start: number, end: number, value: string): PromptBuffer {
  const safeStart = clampToGraphemeBoundary(buffer.text, start);
  const safeEnd = clampToGraphemeBoundary(buffer.text, end);
  const text = `${buffer.text.slice(0, safeStart)}${value}${buffer.text.slice(safeEnd)}`;
  return { text, cursor: safeStart + value.length, selectionAnchor: undefined };
}

function previousGrapheme(text: string, offset: number): string {
  const start = previousGraphemeOffset(text, offset);
  return text.slice(start, offset);
}

function previousGraphemeOffset(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index] ?? 0;
    if (boundary < offset) return boundary;
  }
  return 0;
}

function nextGraphemeOffset(text: string, offset: number): number {
  const boundaries = graphemeBoundaries(text);
  for (const boundary of boundaries) {
    if (boundary > offset) return boundary;
  }
  return text.length;
}

function clampToGraphemeBoundary(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  const boundaries = graphemeBoundaries(text);
  let result = 0;
  for (const boundary of boundaries) {
    if (boundary > offset) break;
    result = boundary;
  }
  return result;
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    for (const item of segmenter.segment(text)) boundaries.push(item.index + item.segment.length);
    return uniqueSortedBoundaries(boundaries, text.length);
  }
  for (const character of text) boundaries.push((boundaries[boundaries.length - 1] ?? 0) + character.length);
  return uniqueSortedBoundaries(boundaries, text.length);
}

function uniqueSortedBoundaries(boundaries: number[], length: number): number[] {
  boundaries.push(length);
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

import { useEffect } from "react";
import { useStdout } from "../../ink.js";
import { PromptInputMode } from "./types.js";

export function PromptInputCursor(props: {
  terminalRows: number;
  promptTop?: number;
  mode: PromptInputMode;
  text: string;
  cursor: number;
  suggestions: number;
  queued: number;
  hasStash: boolean;
  history: number;
}) {
  const { stdout } = useStdout();
  const position = promptCursorPosition(props);

  useEffect(() => schedulePromptCursorMove(stdout, position), [position.x, position.y, stdout]);

  return null;
}

export function promptCursorPosition(input: {
  terminalRows: number;
  promptTop?: number;
  mode: PromptInputMode;
  text: string;
  cursor: number;
  suggestions: number;
  queued: number;
  hasStash: boolean;
  history: number;
}): { x: number; y: number } {
  const promptHeight = 4 + input.suggestions + input.queued + (input.hasStash ? 1 : 0);
  const lineStartY = input.promptTop === undefined ? Math.max(0, input.terminalRows - promptHeight + 1) : input.promptTop;
  const beforeCursor = input.text.slice(0, input.cursor);
  const lines = beforeCursor.split("\n");
  const currentLine = lines[lines.length - 1] ?? "";
  const promptPrefixWidth = 2;

  return {
    x: promptPrefixWidth + terminalDisplayWidth(currentLine),
    y: lineStartY + lines.length - 1
  };
}

function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += characterWidth(character);
  }
  return width;
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

type CursorStdout = {
  isTTY?: boolean;
  write(data: string): unknown;
};

type CursorTimer = ReturnType<typeof setTimeout>;

export function schedulePromptCursorMove(
  stdout: CursorStdout,
  position: { x: number; y: number },
  schedule: (callback: () => void) => CursorTimer = (callback) => setTimeout(callback, 0),
  cancel: (timer: CursorTimer) => void = clearTimeout
): () => void {
  const timer = schedule(() => {
    if (!stdout.isTTY) return;
    stdout.write(`${cursorShow}${cursorTo(position.x, position.y)}`);
  });
  return () => cancel(timer);
}

const cursorShow = "\u001b[?25h";
const blinkingBarCursor = "\u001b[5 q";
const defaultCursor = "\u001b[0 q";

export function applyPromptNativeCursor(stdout: CursorStdout): () => void {
  if (!stdout.isTTY) return () => undefined;
  stdout.write(`${cursorShow}${blinkingBarCursor}`);
  return () => {
    stdout.write(defaultCursor);
  };
}

function cursorTo(x: number, y: number): string {
  return `\u001b[${y + 1};${x + 1}H`;
}

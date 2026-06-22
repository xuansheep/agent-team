export type PromptKeyAction =
  | "submit"
  | "newline"
  | "cancel"
  | "backspace"
  | "left"
  | "right"
  | "history_previous"
  | "history_next"
  | "none";

export type PromptKey = {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export function resolvePromptKey(input: string, key: PromptKey): PromptKeyAction {
  if (key.return && key.meta) return "newline";
  if (input === "\n" && key.ctrl) return "newline";
  if (key.return) return "submit";
  if (key.escape) return "cancel";
  if (key.backspace) return "backspace";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "history_previous";
  if (key.downArrow) return "history_next";
  return "none";
}

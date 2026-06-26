export type PromptKeyAction =
  | "submit"
  | "newline"
  | "cancel"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "home"
  | "end"
  | "delete_to_start"
  | "delete_to_end"
  | "delete_previous_word"
  | "clear"
  | "history_previous"
  | "history_next"
  | "ignore"
  | "none";

export type PromptKey = {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

const homeSequences = new Set(["\u001b[H", "\u001bOH", "\u001b[1~", "\u001b[7~"]);
const endSequences = new Set(["\u001b[F", "\u001bOF", "\u001b[4~", "\u001b[8~"]);
const deleteSequences = new Set(["\u001b[3~", "\u001b[3$", "\u001b[3^"]);

export function resolvePromptKey(input: string, key: PromptKey, mode: "input" | "running" | "permission" | "question" | "waiting_plan_review" | "confirm_interrupt" = "input"): PromptKeyAction {
  if (isMouseReportingSequence(input)) return "ignore";
  if (mode === "permission") {
    if (key.escape) return "cancel";
    return "none";
  }
  if (key.return && key.meta) return "newline";
  if (input === "\n" && key.ctrl) return "newline";
  if (key.ctrl) {
    if (input === "a") return "home";
    if (input === "e") return "end";
    if (input === "u") return "delete_to_start";
    if (input === "k") return "delete_to_end";
    if (input === "w") return "delete_previous_word";
    if (input === "c") return "none";
  }
  if (key.return) return "submit";
  if (key.escape) return "cancel";
  if (key.backspace) return "backspace";
  if (key.delete) return "none";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "history_previous";
  if (key.downArrow) return "history_next";
  return "none";
}

export function resolveRawPromptKey(input: string): PromptKeyAction {
  if (isMouseReportingSequence(input)) return "ignore";
  if (input === "\u007f") return "backspace";
  if (deleteSequences.has(input)) return "delete";
  if (homeSequences.has(input)) return "home";
  if (endSequences.has(input)) return "end";
  return "none";
}


function isMouseReportingSequence(input: string): boolean {
  return isOnlyMouseReportingSequences(input) || isMouseReportingSequenceFragment(input);
}

function isOnlyMouseReportingSequences(input: string): boolean {
  if (!input) return false;
  return input.replace(/\[<\d+;\d+;\d+[mM]/g, "").replace(/\[M[\s\S]{3}/g, "") === "";
}

function isMouseReportingSequenceFragment(input: string): boolean {
  return (
    /^\[<?\d*(?:;\d*){0,2}[mM]?$/.test(input) ||
    /^\[?<\d*(?:;\d*){0,2}[mM]?$/.test(input) ||
    /^\d+;\d+;\d+[mM]$/.test(input)
  );
}

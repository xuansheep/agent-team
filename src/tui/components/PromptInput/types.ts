export type PromptInputMode = "input" | "running" | "permission" | "question" | "waiting_plan_review" | "confirm_interrupt";

export type PromptBuffer = {
  text: string;
  cursor: number;
  selectionAnchor?: number;
};

export type PromptHistory = {
  entries: string[];
  index?: number;
};

export type PromptInputEvent =
  | { type: "submit"; text: string }
  | { type: "cancel" }
  | { type: "command"; name: string; args: string[] }
  | { type: "queue"; text: string }
  | { type: "toggle_log_detail" };

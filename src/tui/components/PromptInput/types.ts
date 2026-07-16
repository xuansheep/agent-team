export type PromptInputMode = "input" | "running" | "permission" | "question" | "waiting_plan_review" | "confirm_interrupt";

export type PromptBuffer = {
  text: string;
  cursor: number;
  selectionAnchor?: number;
};

export type PromptHistory = {
  entries: string[];
  index?: number;
  draft?: string;
};

export type PromptInputImageAttachment = {
  type: "image";
  media_type: "image/png" | "image/jpeg" | "image/webp";
  data: string;
};

export type PromptInputEvent =
  | { type: "submit"; text: string; images?: PromptInputImageAttachment[] }
  | { type: "cancel" }
  | { type: "cycle_mode" }
  | { type: "external_editor" }
  | { type: "external_editor_error"; error: string }
  | { type: "command"; name: string; args: string[] }
  | { type: "queue"; text: string; images?: PromptInputImageAttachment[] };

import { ModelMessage } from "../providers/types.js";

export type RuntimeAttachmentType = "plan_mode" | "plan_mode_reminder" | "plan_mode_exit";

export type RuntimeAttachment = {
  type: RuntimeAttachmentType;
  content: string;
};

export type PlanModeAttachmentInput = {
  sessionId: string;
  planFilePath: string;
  draft?: string;
  sparse?: boolean;
};

export type PlanModeExitAttachmentInput = {
  approvedPlan: string;
  originalInput: unknown;
};

export function buildPlanModeAttachment(input: PlanModeAttachmentInput): RuntimeAttachment {
  if (input.sparse) {
    return {
      type: "plan_mode_reminder",
      content: [
        attachmentMarker("plan_mode_reminder"),
        "Continue planning only. Do not start workflow execution, modify ordinary project files, or run destructive shell commands.",
        `Current plan file: ${input.planFilePath}`
      ].join("\n")
    };
  }

  const lines = [
    attachmentMarker("plan_mode"),
    `Session: ${input.sessionId}`,
    `Current plan file: ${input.planFilePath}`,
    "You are in Plan Mode.",
    "Do not start workflow execution before the user approves the plan.",
    "Do not modify ordinary project files, run destructive shell commands, or launch background workflow tasks.",
    "Use read-only tools for investigation. The only writable target is the current plan file.",
    "When the plan is ready, request approval instead of executing it."
  ];
  if (input.draft?.trim()) lines.push("", "Current draft:", input.draft.trim());
  return { type: "plan_mode", content: lines.join("\n") };
}

export function buildPlanModeExitAttachment(input: PlanModeExitAttachmentInput): RuntimeAttachment {
  return {
    type: "plan_mode_exit",
    content: [
      attachmentMarker("plan_mode_exit"),
      "The user approved the plan. Workflow execution may proceed according to the approved plan and normal permissions.",
      "Original input:",
      JSON.stringify(input.originalInput, null, 2),
      "",
      "Approved plan:",
      input.approvedPlan.trim()
    ].join("\n")
  };
}

export function hasRuntimeAttachment(messages: ModelMessage[], type: RuntimeAttachmentType): boolean {
  const marker = attachmentMarker(type);
  return messages.some((message) => typeof message.content === "string" && message.content.includes(marker));
}

function attachmentMarker(type: RuntimeAttachmentType): string {
  return `ATTACHMENT ${type}`;
}

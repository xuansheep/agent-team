import type { KernelSession } from "../session.js";

export type KernelPlanModeAttachment = {
  type: "plan_mode";
  content: string;
  planFilePath: string;
};

export function buildPlanModeAttachment(session: KernelSession): KernelPlanModeAttachment {
  if (!session.planState || session.toolPermissionContext.mode !== "plan") throw new Error("Plan Mode is not active");
  const planFilePath = session.planState.planFilePath;
  return {
    type: "plan_mode",
    planFilePath,
    content: [
      "Plan Mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools, or otherwise make any changes to the system.",
      `Plan file: ${planFilePath}`,
      "This is the only file you may write or edit. All other actions must be read-only.",
      "Use AskUserQuestion only to clarify requirements or choose between approaches.",
      "Use ExitPlanMode to request plan approval when the plan file is ready.",
      "Do not ask for plan approval via plain text or AskUserQuestion."
    ].join("\n")
  };
}

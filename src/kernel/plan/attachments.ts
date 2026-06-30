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
      "Plan Mode is active. Do not implement code or start workflow execution yet.",
      `Plan file: ${planFilePath}`,
      "Use read-only tools to explore the project.",
      "The current plan file is the only file you may write or edit.",
      "Use AskUserQuestion when clarification is required.",
      "Use ExitPlanMode when the plan is ready for approval.",
      "Do not ask for plan approval in plain text."
    ].join("\n")
  };
}

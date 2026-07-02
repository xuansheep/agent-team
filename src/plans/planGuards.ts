import { readPlan } from "./planFiles.js";

export const PLAN_FILE_REQUIRED_MESSAGE = "Plan Mode cannot request approval yet because the current plan file is empty. Write the implementation plan to the current plan file first, then call ExitPlanMode again.";

export async function readRequiredPlan(planFilePath: string): Promise<string> {
  const document = (await readPlan(planFilePath))?.trim() ?? "";
  if (!document) {
    throw new Error(`No plan file found at ${planFilePath}. Please write your plan to this file before calling ExitPlanMode.`);
  }
  return document;
}

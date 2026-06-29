import { isAbsolute, relative, resolve } from "node:path";
import { ToolContext } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

export function writesSessionPlanFile(input: unknown, context: ToolContext): boolean {
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath !== "string") return false;
  const target = resolveWorkspacePath(context.cwd, filePath);
  const currentPlanFile = (context as { planFilePath?: unknown }).planFilePath;
  if (typeof currentPlanFile === "string") {
    const planPath = resolveWorkspacePath(context.cwd, currentPlanFile);
    const relativePath = relative(planPath, target);
    return relativePath === "" || relativePath === ".";
  }
  const plansDir = resolve(context.cwd, ".session", "plans");
  const pathFromPlans = relative(plansDir, target);
  return pathFromPlans !== "" && !pathFromPlans.startsWith("..") && !isAbsolute(pathFromPlans);
}

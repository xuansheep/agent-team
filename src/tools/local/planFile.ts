import { isAbsolute, relative, resolve } from "node:path";
import { ToolContext } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

export function writesSessionPlanFile(input: unknown, context: ToolContext): boolean {
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath !== "string") return false;
  const currentPlanFile = (context as ToolContext & { planFilePath?: unknown }).planFilePath;
  if (typeof currentPlanFile !== "string") return false;
  return samePath(resolveToolPath(context.cwd, filePath), resolveToolPath(context.cwd, currentPlanFile));
}

export function resolvePlanAwareWritePath(context: ToolContext, filePath: string): string {
  const target = resolveToolPath(context.cwd, filePath);
  const currentPlanFile = (context as ToolContext & { planFilePath?: unknown }).planFilePath;
  if (typeof currentPlanFile === "string" && samePath(target, resolveToolPath(context.cwd, currentPlanFile))) {
    return target;
  }
  return resolveWorkspacePath(context.cwd, filePath);
}

function resolveToolPath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function samePath(left: string, right: string): boolean {
  const fromRight = relative(right, left);
  return fromRight === "" || fromRight === ".";
}

import { isAbsolute, resolve } from "node:path";
import { checkToolPermission } from "../../permissions/checkToolPermission.js";
import type { ToolPermissionCheckContext, ToolPermissionDecision } from "../../permissions/context.js";
import type { KernelTool } from "../tools/protocol.js";

const shellTools = new Set(["Bash", "PowerShell"]);
const blockedInPlanMode = new Set(["StartWorkflow", "WorkflowRun", "AgentTask"]);
const writeTools = new Set(["Write", "Edit", "MultiEdit"]);

export class PermissionKernel {
  async check(tool: KernelTool, input: unknown, context: ToolPermissionCheckContext): Promise<ToolPermissionDecision> {
    if (context.mode === "plan") {
      if (shellTools.has(tool.name)) return { decision: "deny", reason: "Plan Mode blocks shell execution" };
      if (blockedInPlanMode.has(tool.name)) return { decision: "deny", reason: "Plan Mode blocks execution tools" };
      if (writeTools.has(tool.name)) return planFileWriteDecision(input, context);
    }
    return checkToolPermission(tool.legacyTool, input, context);
  }
}

function planFileWriteDecision(input: unknown, context: ToolPermissionCheckContext): ToolPermissionDecision {
  const planFilePath = context.planFilePath;
  if (!planFilePath) return { decision: "deny", reason: "Plan Mode has no plan file" };
  const filePath = toolFilePath(input);
  if (!filePath) return { decision: "deny", reason: "Plan Mode write tool input has no file path" };
  const cwd = context.cwd ?? process.cwd();
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  const plan = isAbsolute(planFilePath) ? resolve(planFilePath) : resolve(cwd, planFilePath);
  if (target !== plan) return { decision: "deny", reason: "Plan Mode writes are limited to the current plan file" };
  return { decision: "allow", reason: "Plan Mode plan file write" };
}

function toolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as { file_path?: unknown; path?: unknown };
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.path === "string") return value.path;
  return undefined;
}

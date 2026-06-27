import { isAbsolute, relative, resolve } from "node:path";
import { decidePermission } from "../harness/permissions.js";
import { Tool } from "../tools/types.js";
import { ToolPermissionCheckContext, ToolPermissionDecision } from "./context.js";

export async function checkToolPermission(
  tool: Tool,
  input: unknown,
  context: ToolPermissionCheckContext
): Promise<ToolPermissionDecision> {
  const specifier = toolSpecifier(tool.name, input);
  const denyDecision = firstRuleDecision(tool.name, specifier, context.deny, "deny");
  if (denyDecision) return denyDecision;

  if (context.mode === "plan") return checkPlanModePermission(tool, input, context);
  if (context.mode === "bypassPermissions") return { decision: "allow" };

  return decidePermission(tool.name, specifier, context);
}

async function checkPlanModePermission(
  tool: Tool,
  input: unknown,
  context: ToolPermissionCheckContext
): Promise<ToolPermissionDecision> {
  if (tool.isReadOnly?.()) return { decision: "allow", reason: "plan mode read-only tool" };
  if (await writesCurrentPlanFile(tool, input, context)) return { decision: "allow", reason: "plan mode current plan file" };
  if (tool.name === "Bash" || tool.name === "PowerShell") {
    if (await tool.isDestructive?.(input)) {
      return { decision: "deny", reason: "Plan Mode blocks destructive shell commands" };
    }
    return { decision: "deny", reason: "Plan Mode blocks shell execution" };
  }
  if (isWorkflowExecutionTool(tool.name)) {
    return { decision: "deny", reason: "Plan Mode blocks workflow execution" };
  }
  return { decision: "deny", reason: "Plan Mode allows only read-only tools and the current plan file" };
}

async function writesCurrentPlanFile(tool: Tool, input: unknown, context: ToolPermissionCheckContext): Promise<boolean> {
  if (!context.planFilePath || !await tool.writesPlanFile?.(input, context)) return false;
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath !== "string") return false;
  return samePath(resolve(context.cwd, filePath), resolve(context.cwd, context.planFilePath));
}

function samePath(left: string, right: string): boolean {
  const fromRight = relative(right, left);
  return fromRight === "" || fromRight === ".";
}

function firstRuleDecision(
  tool: string,
  specifier: string,
  rules: string[],
  decision: "deny"
): ToolPermissionDecision | undefined {
  for (const rule of rules) {
    const result = decidePermission(tool, specifier, { allow: [], ask: [], deny: [rule] });
    if (result.decision === decision) return result;
  }
  return undefined;
}

function isWorkflowExecutionTool(toolName: string): boolean {
  return toolName === "WorkflowRun" || toolName === "WorkflowResume" || toolName === "RunWorkflow";
}

function toolSpecifier(tool: string, input: unknown): string {
  const value = input as Record<string, unknown>;
  if (tool === "Bash" || tool === "PowerShell") return String(value.command ?? "");
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.path === "string") return value.path;
  if (typeof value.url === "string") return value.url;
  return "";
}

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
  if (tool.name === "ExitPlanMode" && context.mode !== "plan") {
    return {
      decision: "deny",
      reason: "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation."
    };
  }

  if (context.mode === "plan") return checkPlanModePermission(tool, input, context);
  if (context.mode === "acceptEdits") return checkAcceptEditsPermission(tool, specifier, context);
  if (context.mode === "auto") return checkAutoPermission(tool, input, specifier, context);
  if (context.mode === "dontAsk") return checkDontAskPermission(tool, specifier, context);
  if (context.mode === "bypassPermissions") return { decision: "allow" };

  return decidePermission(tool.name, specifier, context);
}

function checkAcceptEditsPermission(
  tool: Tool,
  specifier: string,
  context: ToolPermissionCheckContext
): ToolPermissionDecision {
  const ruleDecision = decidePermission(tool.name, specifier, context);
  if (ruleDecision.decision !== "ask") return ruleDecision;
  if (isEditTool(tool.name)) return { decision: "allow", reason: "acceptEdits mode edit tool" };
  return ruleDecision;
}

async function checkAutoPermission(
  tool: Tool,
  input: unknown,
  specifier: string,
  context: ToolPermissionCheckContext
): Promise<ToolPermissionDecision> {
  const ruleDecision = decidePermission(tool.name, specifier, context);
  if (ruleDecision.decision !== "ask") return ruleDecision;
  if (tool.isReadOnly?.(input, context)) return { decision: "allow", reason: "auto mode read-only tool" };
  if (isEditTool(tool.name)) return { decision: "allow", reason: "auto mode edit tool" };
  if (await tool.isDestructive?.(input)) return { decision: "deny", reason: "Auto mode blocks destructive tool without classifier approval" };
  return { decision: "deny", reason: "Auto mode requires classifier approval for this tool" };
}

function checkDontAskPermission(
  tool: Tool,
  specifier: string,
  context: ToolPermissionCheckContext
): ToolPermissionDecision {
  const ruleDecision = decidePermission(tool.name, specifier, context);
  if (ruleDecision.decision !== "ask") return ruleDecision;
  return { decision: "deny", reason: "dontAsk mode blocks permission prompts" };
}

async function checkPlanModePermission(
  tool: Tool,
  input: unknown,
  context: ToolPermissionCheckContext
): Promise<ToolPermissionDecision> {
  if (tool.isReadOnly?.(input, context)) return { decision: "allow", reason: "plan mode read-only tool" };
  if (tool.name === "ExitPlanMode") return { decision: "ask", reason: "Exit plan mode?" };
  if (tool.name === "AskUserQuestion") return { decision: "allow", reason: "plan mode clarification tool" };

  if (await writesCurrentPlanFile(tool, input, context)) return { decision: "allow", reason: "plan mode current plan file" };
  if (tool.name === "Bash" || tool.name === "PowerShell") {
    return { decision: "deny", reason: "Plan Mode blocks shell execution" };
  }
  if (isWorkflowExecutionTool(tool.name)) {
    return { decision: "deny", reason: "Plan Mode blocks workflow execution" };
  }
  return {
    decision: "deny",
    reason: context.planFilePath
      ? `Plan Mode allows only read-only tools and the current plan file. Write or edit only ${context.planFilePath} to prepare the plan, then call ExitPlanMode.`
      : "Plan Mode allows only read-only tools and the current plan file"
  };
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

function isEditTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "ArtifactWrite" || toolName === "TodoWrite";
}

function toolSpecifier(tool: string, input: unknown): string {
  const value = input as Record<string, unknown>;
  if (tool === "Bash" || tool === "PowerShell") return String(value.command ?? "");
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.path === "string") return value.path;
  if (typeof value.url === "string") return value.url;
  return "";
}

import { isAbsolute, relative, resolve, sep } from "node:path";
import { decidePermission } from "../harness/permissions.js";
import { Tool } from "../tools/types.js";
import { ToolPermissionCheckContext, ToolPermissionDecision } from "./context.js";

export async function checkToolPermission(
  tool: Tool,
  input: unknown,
  context: ToolPermissionCheckContext
): Promise<ToolPermissionDecision> {
  const specifiers = toolSpecifierCandidates(tool.name, input, context.cwd);
  const specifier = specifiers[0]!;
  const denyDecision = firstRuleDecision(tool.name, specifiers, context.deny, "deny");
  if (denyDecision) return denyDecision;
  if (tool.name === "ExitPlanMode" && context.mode !== "plan") {
    return {
      decision: "deny",
      reason: "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation."
    };
  }

  if (context.mode === "plan") return checkPlanModePermission(tool, input, context);
  if (tool.name === "ToolSearch") return { decision: "allow", reason: "safe deferred tool discovery" };

  const askDecision = firstRuleDecision(tool.name, specifiers, context.ask, "ask");
  if (askDecision) return askDecision;

  if (await tool.requiresPermissionPrompt?.(input, context)) {
    return { decision: "ask", reason: `Safety confirmation required for ${tool.name}` };
  }

  if (context.mode === "fullAccess") return { decision: "allow" };
  if (tool.name === "UseSkill") return { decision: "allow", reason: "safe skill activation" };

  return decidePermission(tool.name, specifier, {
    deny: context.deny,
    ask: context.ask,
    allow: [...context.allow, ...(context.transientAllow ?? [])]
  });
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
  specifiers: string[],
  rules: string[],
  decision: "ask" | "deny"
): ToolPermissionDecision | undefined {
  for (const rule of rules) {
    const permissions = decision === "deny"
      ? { allow: [], ask: [], deny: [rule] }
      : { allow: [], ask: [rule], deny: [] };
    for (const specifier of specifiers) {
      const result = decidePermission(tool, specifier, permissions);
      if (result.decision === decision) return result;
    }
  }
  return undefined;
}

function isWorkflowExecutionTool(toolName: string): boolean {
  return toolName === "WorkflowRun" || toolName === "WorkflowResume" || toolName === "RunWorkflow";
}

// Rules are matched against every form a path can arrive in, so `./.env`, `src/../.env` and an
// absolute path all still hit a `Read(.env)` deny rule. The first entry is the canonical form.
function toolSpecifierCandidates(tool: string, input: unknown, cwd: string): string[] {
  const value = input as Record<string, unknown>;
  if (tool === "Bash" || tool === "PowerShell") return [String(value.command ?? "")];
  if (tool === "UseSkill") return [String(value.name ?? "").trim().replace(/^\//, "")];
  const filePath = typeof value.file_path === "string" ? value.file_path : typeof value.path === "string" ? value.path : undefined;
  if (filePath !== undefined) return [...new Set([workspaceRelativePath(cwd, filePath), filePath])];
  if (typeof value.url === "string") return [value.url];
  return [""];
}

function workspaceRelativePath(cwd: string, value: string): string {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(resolve(cwd), absolute);
  return (rel === "" ? "." : rel).split(sep).join("/");
}

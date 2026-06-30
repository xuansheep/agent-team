import { checkToolPermission } from "../../permissions/checkToolPermission.js";
import type { ToolPermissionCheckContext, ToolPermissionDecision } from "../../permissions/context.js";
import type { KernelTool } from "../tools/protocol.js";

export class PermissionKernel {
  async check(tool: KernelTool, input: unknown, context: ToolPermissionCheckContext): Promise<ToolPermissionDecision> {
    if (context.mode === "plan" && (tool.name === "Bash" || tool.name === "PowerShell")) {
      return { decision: "deny", reason: "Plan Mode blocks shell execution" };
    }
    return checkToolPermission(tool.legacyTool, input, context);
  }
}

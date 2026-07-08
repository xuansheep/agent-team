import type { HookRuntime, HookRuntimeDiagnostic } from "../hooks/runtime.js";
import type { McpRuntime, McpRuntimeDiagnostic } from "../mcp/runtime.js";
import type { SkillRuntime, SkillRuntimeDiagnostic } from "../skills/runtime.js";

export type RuntimeDiagnostics = {
  mcp: McpRuntimeDiagnostic[];
  skills: SkillRuntimeDiagnostic[];
  hooks: HookRuntimeDiagnostic[];
};

export function collectRuntimeDiagnostics(input: {
  mcpRuntime?: McpRuntime;
  skillRuntime?: SkillRuntime;
  hookRuntime?: HookRuntime;
}): RuntimeDiagnostics {
  return {
    mcp: input.mcpRuntime?.getDiagnostics() ?? [],
    skills: input.skillRuntime?.getDiagnostics() ?? [],
    hooks: input.hookRuntime?.getDiagnostics() ?? []
  };
}

import type { McpRuntime, McpRuntimeDiagnostic } from "../mcp/runtime.js";
import type { SkillRuntime, SkillRuntimeDiagnostic } from "../skills/runtime.js";

export type RuntimeDiagnostics = {
  mcp: McpRuntimeDiagnostic[];
  skills: SkillRuntimeDiagnostic[];
};

export function collectRuntimeDiagnostics(input: {
  mcpRuntime?: McpRuntime;
  skillRuntime?: SkillRuntime;
}): RuntimeDiagnostics {
  return {
    mcp: input.mcpRuntime?.getDiagnostics() ?? [],
    skills: input.skillRuntime?.getDiagnostics() ?? []
  };
}

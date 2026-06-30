import type { ToolPermissionContext } from "../../permissions/context.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { adaptToolToKernelTool, type KernelTool } from "./protocol.js";

const planModeVisibleTools = new Set([
  "Read",
  "List",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode"
]);

export class KernelToolRegistry {
  private readonly tools = new Map<string, KernelTool>();

  add(tool: KernelTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): KernelTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool;
  }

  list(): KernelTool[] {
    return [...this.tools.values()];
  }

  visibleTools(context: ToolPermissionContext): KernelTool[] {
    if (context.mode !== "plan") return this.list();
    return this.list().filter((tool) => planModeVisibleTools.has(tool.name));
  }
}

export function createKernelToolRegistry(legacy: ToolRegistry): KernelToolRegistry {
  const registry = new KernelToolRegistry();
  for (const tool of legacy.list()) registry.add(adaptToolToKernelTool(tool));
  return registry;
}

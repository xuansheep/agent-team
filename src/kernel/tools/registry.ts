import type { ToolPermissionContext } from "../../permissions/context.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { adaptToolToKernelTool, type KernelTool } from "./protocol.js";

const planModeVisibleTools = new Set([
  "Read",
  "LS",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Write",
  "Edit",
  "MultiEdit",

  "AskUserQuestion",
  "ExitPlanMode"
]);

const planModeWriteTools = new Set(["Write", "Edit", "MultiEdit"]);

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
    return this.list()
      .filter((tool) => planModeVisibleTools.has(tool.name))
      .map((tool) => planModeModelVisibleTool(tool, context));
  }
}

export function createKernelToolRegistry(legacy: ToolRegistry): KernelToolRegistry {
  const registry = new KernelToolRegistry();
  for (const tool of legacy.list()) registry.add(adaptToolToKernelTool(tool));
  return registry;
}

function planModeModelVisibleTool(tool: KernelTool, context: ToolPermissionContext): KernelTool {
  if (!planModeWriteTools.has(tool.name)) return tool;
  const planFilePath = context.planFilePath ?? "the current plan file";
  return {
    ...tool,
    description: `${tool.description}. In Plan Mode this tool may ONLY write the current plan file: ${planFilePath}. Do not use it to edit source code.`,
    prompt: planModeWritePrompt(tool, planFilePath),
    legacyTool: {
      ...tool.legacyTool,
      description: `${tool.legacyTool.description}. In Plan Mode this tool may ONLY write the current plan file: ${planFilePath}. Do not use it to edit source code.`,
      prompt: planModeWritePrompt(tool, planFilePath)
    }
  };
}

function planModeWritePrompt(tool: KernelTool, planFilePath: string): string {
  const base = typeof tool.prompt === "function" ? tool.prompt() : tool.prompt;
  return [
    `Plan Mode restriction: ${tool.name} is available only for maintaining the current plan file: ${planFilePath}.`,
    `Set file_path exactly to ${planFilePath}.`,
    "Never use this tool to modify source files, configs, tests, generated artifacts, or any non-plan file while Plan Mode is active.",
    base?.trim() ? base.trim() : undefined
  ].filter(Boolean).join("\n\n");
}

import { Tool } from "./types.js";
import { readTool } from "./local/read.js";
import { writeTool } from "./local/write.js";
import { editTool } from "./local/edit.js";
import { multiEditTool } from "./local/multiEdit.js";
import { lsTool } from "./local/list.js";
import { globTool } from "./local/glob.js";
import { grepTool } from "./local/grep.js";
import { bashTool } from "./local/bash.js";
import { powerShellTool } from "./local/powershell.js";
import { todoWriteTool } from "./local/todoWrite.js";
import { attachImageTool } from "./local/attachImage.js";
import { artifactWriteTool } from "./local/artifactWrite.js";
import { webFetchTool } from "./local/webFetch.js";
import { webSearchTool } from "./local/webSearch.js";
import { enterPlanModeTool } from "./local/enterPlanMode.js";
import { exitPlanModeTool } from "./local/exitPlanMode.js";
import { askUserQuestionTool } from "./local/askUserQuestion.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { createMcpToolSearchTool } from "../mcp/deferredTools.js";
import { createListMcpResourcesTool, createReadMcpResourceTool } from "../mcp/resourceTools.js";
import { createGetMcpPromptTool, createListMcpPromptsTool, createRunMcpPromptTool } from "../mcp/promptTools.js";
import type { SkillRuntime } from "../skills/runtime.js";
import { createListSkillsTool, createUseSkillTool } from "../skills/skillTools.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(readonly skillRuntime?: SkillRuntime) {}

  add(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  activateSkillsForInput(input: unknown, cwd: string): string[] {
    return this.skillRuntime?.activateForPaths(candidatePaths(input), cwd) ?? [];
  }
}

export function createLocalToolRegistry(options: { mcpRuntime?: McpRuntime; skillRuntime?: SkillRuntime } = {}): ToolRegistry {
  const registry = new ToolRegistry(options.skillRuntime);
  for (const tool of [
    readTool,
    writeTool,
    editTool,
    multiEditTool,
    lsTool,
    globTool,
    grepTool,
    bashTool,
    powerShellTool,
    todoWriteTool,
    artifactWriteTool,
    attachImageTool,
    webFetchTool,
    webSearchTool,
    enterPlanModeTool,
    exitPlanModeTool,
    askUserQuestionTool
  ]) {
    registry.add(tool);
  }
  if (options.mcpRuntime) {
    registry.add(createMcpToolSearchTool(options.mcpRuntime));
    registry.add(createListMcpResourcesTool(options.mcpRuntime));
    registry.add(createReadMcpResourceTool(options.mcpRuntime));
    registry.add(createListMcpPromptsTool(options.mcpRuntime));
    registry.add(createGetMcpPromptTool(options.mcpRuntime));
    registry.add(createRunMcpPromptTool(options.mcpRuntime));
  }
  if (options.skillRuntime) {
    registry.add(createListSkillsTool(options.skillRuntime));
    registry.add(createUseSkillTool(options.skillRuntime));
  }
  return registry;
}


function candidatePaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  return [record.file_path, record.path, record.cwd, record.directory]
    .flatMap((value) => typeof value === "string" && value.trim() ? [value] : []);
}

export function createPlanModeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    readTool,
    writeTool,
    editTool,
    multiEditTool,
    lsTool,
    globTool,
    grepTool,
    webFetchTool,
    webSearchTool,
    todoWriteTool,
    askUserQuestionTool,
    exitPlanModeTool
  ]) {
    registry.add(tool);
  }
  return registry;
}

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

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  add(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

export function createLocalToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
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
    exitPlanModeTool
  ]) {
    registry.add(tool);
  }
  return registry;
}

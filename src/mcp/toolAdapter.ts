import { Tool, ToolResult } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { McpClient, McpToolCallResult, McpToolDefinition } from "./types.js";

export function mcpToolToTool(client: McpClient, definition: McpToolDefinition): Tool {
  return {
    name: definition.name,
    description: definition.description ?? `MCP tool ${definition.name}`,
    input_schema: definition.inputSchema ?? {},
    isReadOnly: () => definition.readOnly === true,
    isConcurrencySafe: () => definition.readOnly === true,
    isDestructive: () => definition.destructive === true,
    async execute(input) {
      return mcpResultToToolResult(await client.callTool(definition.name, input) as McpToolCallResult);
    }
  };
}

export async function registerMcpTools(client: McpClient, registry: ToolRegistry): Promise<Tool[]> {
  const tools = (await client.listTools()).map((definition) => mcpToolToTool(client, definition));
  for (const tool of tools) registry.add(tool);
  return tools;
}

function mcpResultToToolResult(result: McpToolCallResult): ToolResult {
  const output = textContent(result);
  return {
    ...(output ? { output } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.isError ? { error: result.error ?? output ?? "MCP tool returned an error" } : {})
  };
}

function textContent(result: McpToolCallResult): string | undefined {
  const texts = result.content
    ?.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  return texts?.length ? texts.join("\n") : undefined;
}

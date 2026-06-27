import { McpClient, McpToolCallResult, McpToolDefinition } from "./types.js";

export type InMemoryMcpTool = McpToolDefinition & {
  execute(input: unknown): Promise<McpToolCallResult> | McpToolCallResult;
};

export class InMemoryMcpClient implements McpClient {
  private readonly tools: Map<string, InMemoryMcpTool>;

  constructor(tools: InMemoryMcpTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async listTools(): Promise<McpToolDefinition[]> {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }

  async callTool(name: string, input: unknown): Promise<McpToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool ${name}`);
    return tool.execute(input);
  }
}

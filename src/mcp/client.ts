import { McpClient, McpPrompt, McpResource, McpToolCallResult, McpToolDefinition } from "./types.js";

export type InMemoryMcpTool = McpToolDefinition & {
  execute(input: unknown): Promise<McpToolCallResult> | McpToolCallResult;
};

export class InMemoryMcpClient implements McpClient {
  private readonly tools: Map<string, InMemoryMcpTool>;

  constructor(
    tools: InMemoryMcpTool[],
    private readonly resources: McpResource[] = [],
    private readonly prompts: McpPrompt[] = []
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async initialize(): Promise<void> {}

  getMetadata() { return {}; }

  onListChanged(): void {}

  async listTools(): Promise<McpToolDefinition[]> {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }

  async callTool(name: string, input: unknown): Promise<McpToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool ${name}`);
    return tool.execute(input);
  }

  async listResources(): Promise<McpResource[]> {
    return this.resources;
  }

  async readResource(uri: string): Promise<{ contents: [] }> {
    const resource = this.resources.find((item) => item.uri === uri);
    if (!resource) throw new Error(`Unknown MCP resource ${uri}`);
    return { contents: [] };
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return this.prompts;
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<{ messages: [] }> {
    const prompt = this.prompts.find((item) => item.name === name);
    if (!prompt) throw new Error(`Unknown MCP prompt ${name}`);
    void args;
    return { messages: [] };
  }

  async close(): Promise<void> {}
}

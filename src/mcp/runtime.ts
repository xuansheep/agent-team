import type { ResolvedMcpServerConfig } from "./schema.js";
import type { McpClient, McpPrompt, McpResource, McpTool } from "./types.js";

export type McpServerState = "pending" | "connected" | "failed" | "disabled";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  error?: string;
};

export type RuntimeMcpTool = McpTool & {
  server: string;
  name: string;
  originalName: string;
};

export type McpRuntimeOptions = {
  clientFactory(server: ResolvedMcpServerConfig): Promise<McpClient>;
};

export type McpRuntimeDiagnostic = McpServerStatus & {
  source: ResolvedMcpServerConfig["source"];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
};

type ServerRecord = {
  config: ResolvedMcpServerConfig;
  status: McpServerStatus;
  client?: McpClient;
  tools: RuntimeMcpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
};

export class McpRuntime {
  private readonly servers = new Map<string, ServerRecord>();

  constructor(private readonly options: McpRuntimeOptions) {}

  async connectAll(configs: ResolvedMcpServerConfig[]): Promise<void> {
    await Promise.all(configs.map((config) => this.connect(config)));
  }

  async connect(config: ResolvedMcpServerConfig): Promise<void> {
    const record: ServerRecord = {
      config,
      status: { name: config.name, state: config.disabled ? "disabled" : "pending" },
      tools: [],
      resources: [],
      prompts: []
    };
    this.servers.set(config.name, record);
    if (config.disabled) return;

    try {
      const client = await this.options.clientFactory(config);
      record.client = client;
      record.tools = (await client.listTools()).map((tool) => ({
        ...tool,
        server: config.name,
        originalName: tool.name,
        name: mcpToolName(config.name, tool.name)
      }));
      record.resources = await client.listResources();
      record.prompts = await client.listPrompts();
      record.status = { name: config.name, state: "connected" };
    } catch (error) {
      record.status = { name: config.name, state: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  getServerStatus(name: string): McpServerStatus | undefined {
    return this.servers.get(name)?.status;
  }

  listServerStatuses(): McpServerStatus[] {
    return [...this.servers.values()].map((record) => record.status);
  }

  getDiagnostics(): McpRuntimeDiagnostic[] {
    return [...this.servers.values()].map((record) => ({
      ...record.status,
      source: record.config.source,
      toolCount: record.tools.length,
      resourceCount: record.resources.length,
      promptCount: record.prompts.length
    }));
  }

  listTools(): RuntimeMcpTool[] {
    return [...this.servers.values()].flatMap((record) => record.tools);
  }

  async callTool(server: string, tool: string, input: unknown): Promise<unknown> {
    const record = this.requireConnectedServer(server);
    return record.client.callTool(tool, input);
  }

  async listResources(input: { server?: string } = {}): Promise<Array<McpResource & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) =>
      record.resources.map((resource) => ({ ...resource, server: record.config.name }))
    );
  }

  async readResource(server: string, uri: string): Promise<unknown> {
    return this.requireConnectedServer(server).client.readResource(uri);
  }

  async listPrompts(input: { server?: string } = {}): Promise<Array<McpPrompt & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) =>
      record.prompts.map((prompt) => ({ ...prompt, server: record.config.name }))
    );
  }

  async getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.requireConnectedServer(server).client.getPrompt(name, args);
  }

  private matchingRecords(server?: string): ServerRecord[] {
    if (server) return [this.requireConnectedServer(server)];
    return [...this.servers.values()].filter((record) => record.status.state === "connected" && record.client);
  }

  private requireConnectedServer(server: string): ServerRecord & { client: McpClient } {
    const record = this.servers.get(server);
    if (!record) throw new Error(`Unknown MCP server ${server}`);
    if (record.status.state !== "connected" || !record.client) throw new Error(`MCP server ${server} is not connected`);
    return record as ServerRecord & { client: McpClient };
  }
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

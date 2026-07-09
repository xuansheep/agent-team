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
  sourcePath?: string;
  sourceFormat?: ResolvedMcpServerConfig["sourceFormat"];
  transport: ResolvedMcpServerConfig["type"];
  disabled?: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
};

export type McpToolDiagnostic = RuntimeMcpTool;

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

    let client: McpClient | undefined;
    try {
      client = await this.options.clientFactory(config);
      await client.initialize?.();
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
      await client?.close?.().catch(() => undefined);
      record.status = { name: config.name, state: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async disconnect(name: string, state: McpServerState = "disabled"): Promise<void> {
    const record = this.servers.get(name);
    if (!record) throw new Error(`Unknown MCP server ${name}`);
    const closeError = await closeClient(record.client);
    record.client = undefined;
    record.tools = [];
    record.resources = [];
    record.prompts = [];
    record.status = closeError ? { name, state, error: closeError } : { name, state };
    if (closeError) throw new Error(closeError);
  }

  async reconnect(config: ResolvedMcpServerConfig): Promise<void> {
    if (this.servers.has(config.name)) await this.disconnect(config.name, config.disabled ? "disabled" : "pending");
    await this.connect(config);
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
      sourcePath: record.config.sourcePath,
      sourceFormat: record.config.sourceFormat,
      transport: record.config.type,
      disabled: record.config.disabled,
      toolCount: record.tools.length,
      resourceCount: record.resources.length,
      promptCount: record.prompts.length
    }));
  }

  listTools(): RuntimeMcpTool[] {
    return [...this.servers.values()].flatMap((record) => record.tools);
  }

  listToolDiagnostics(server?: string): McpToolDiagnostic[] {
    if (!server) return [...this.servers.values()].flatMap((record) => record.tools);
    const record = this.servers.get(server);
    if (!record) throw new Error(`Unknown MCP server ${server}`);
    return record.tools.slice();
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

async function closeClient(client: McpClient | undefined): Promise<string | undefined> {
  try {
    await client?.close?.();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

import type { ResolvedMcpServerConfig } from "./schema.js";
import type { McpClient, McpPrompt, McpResource, McpResourceTemplate, McpServerMetadata, McpTool, McpToolCallResult } from "./types.js";

export type McpServerState = "pending" | "connected" | "failed" | "disabled";

export type McpServerStatus = { name: string; state: McpServerState; error?: string };

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
  resourceTemplateCount?: number;
  capabilities?: Record<string, unknown>;
  serverInfo?: McpServerMetadata["serverInfo"];
  instructions?: string;
};

export type McpToolDiagnostic = RuntimeMcpTool;
export type McpPromptCommand = { name: string; server: string; prompt: string; description?: string; argumentHint?: string };

type ServerRecord = {
  config: ResolvedMcpServerConfig;
  status: McpServerStatus;
  client?: McpClient;
  metadata: McpServerMetadata;
  tools: RuntimeMcpTool[];
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
  prompts: McpPrompt[];
};

export class McpRuntime {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly catalogListeners = new Set<(kind: "tools" | "resources" | "prompts", server: string) => void | Promise<void>>();

  constructor(private readonly options: McpRuntimeOptions) {}

  async connectAll(configs: ResolvedMcpServerConfig[]): Promise<void> {
    const nextNames = new Set(configs.map((config) => config.name));
    await Promise.all([...this.servers.keys()].filter((name) => !nextNames.has(name)).map(async (name) => {
      await closeClient(this.servers.get(name)?.client);
      this.servers.delete(name);
    }));
    await Promise.all(configs.map((config) => this.reconnect(config)));
  }

  async connect(config: ResolvedMcpServerConfig): Promise<void> {
    const record: ServerRecord = {
      config,
      status: { name: config.name, state: config.disabled ? "disabled" : "pending" },
      metadata: {},
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: []
    };
    this.servers.set(config.name, record);
    if (config.disabled) return;

    let client: McpClient | undefined;
    try {
      client = await this.options.clientFactory(config);
      await client.initialize?.();
      record.client = client;
      record.metadata = client.getMetadata?.() ?? {};
      client.onListChanged?.({
        tools: async (tools) => { record.tools = runtimeTools(config.name, tools); await this.notifyCatalog("tools", config.name); },
        resources: async (resources) => { record.resources = resources.slice(); record.resourceTemplates = await client!.listResourceTemplates?.() ?? []; await this.notifyCatalog("resources", config.name); },
        prompts: async (prompts) => { record.prompts = prompts.slice(); await this.notifyCatalog("prompts", config.name); }
      });
      const [tools, resources, resourceTemplates, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listResourceTemplates?.() ?? [], client.listPrompts()]);
      record.tools = runtimeTools(config.name, tools);
      record.resources = resources;
      record.resourceTemplates = resourceTemplates;
      record.prompts = prompts;
      record.status = { name: config.name, state: "connected" };
    } catch (error) {
      await closeClient(client);
      record.client = undefined;
      record.status = { name: config.name, state: "failed", error: errorMessage(error) };
    }
  }

  async disconnect(name: string, state: McpServerState = "disabled"): Promise<void> {
    const record = this.servers.get(name);
    if (!record) throw new Error(`Unknown MCP server ${name}`);
    const closeError = await closeClient(record.client);
    record.client = undefined;
    record.tools = [];
    record.resources = [];
    record.resourceTemplates = [];
    record.prompts = [];
    record.status = closeError ? { name, state, error: closeError } : { name, state };
    if (closeError) throw new Error(closeError);
  }

  async reconnect(config: ResolvedMcpServerConfig): Promise<void> {
    const existing = this.servers.get(config.name);
    if (existing) await closeClient(existing.client);
    await this.connect(config);
  }

  onCatalogChanged(listener: (kind: "tools" | "resources" | "prompts", server: string) => void | Promise<void>): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
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
      resourceTemplateCount: record.resourceTemplates.length,
      promptCount: record.prompts.length,
      capabilities: record.metadata.capabilities,
      serverInfo: record.metadata.serverInfo,
      instructions: record.metadata.instructions
    })).sort((left, right) => left.name.localeCompare(right.name));
  }

  listTools(): RuntimeMcpTool[] {
    return [...this.servers.values()].flatMap((record) => record.tools);
  }

  listToolDiagnostics(server?: string): McpToolDiagnostic[] {
    if (!server) return this.listTools();
    const record = this.servers.get(server);
    if (!record) throw new Error(`Unknown MCP server ${server}`);
    return record.tools.slice();
  }

  getServerInstructions(): string[] {
    return [...this.servers.values()].flatMap((record) => record.status.state === "connected" && record.metadata.instructions
      ? [`MCP server ${record.config.name} instructions:\n${record.metadata.instructions}`]
      : []);
  }

  listPromptCommands(): McpPromptCommand[] {
    return [...this.servers.values()].flatMap((record) => record.prompts.map((prompt) => ({
      name: mcpPromptCommandName(record.config.name, prompt.name),
      server: record.config.name,
      prompt: prompt.name,
      description: prompt.description,
      argumentHint: prompt.arguments?.map((argument) => `${argument.required ? "<" : "["}${argument.name}${argument.required ? ">" : "]"}`).join(" ")
    })));
  }

  async callTool(server: string, tool: string, input: unknown): Promise<McpToolCallResult> {
    return await this.requireConnectedServer(server).client.callTool(tool, input) as McpToolCallResult;
  }

  async listResources(input: { server?: string } = {}): Promise<Array<McpResource & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) => record.resources.map((resource) => ({ ...resource, server: record.config.name })));
  }

  async listResourceTemplates(input: { server?: string } = {}): Promise<Array<McpResourceTemplate & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) => record.resourceTemplates.map((template) => ({ ...template, server: record.config.name })));
  }

  async readResource(server: string, uri: string) {
    return this.requireConnectedServer(server).client.readResource(uri);
  }

  async listPrompts(input: { server?: string } = {}): Promise<Array<McpPrompt & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) => record.prompts.map((prompt) => ({ ...prompt, server: record.config.name })));
  }

  async getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<{ description?: string; messages: import("./types.js").McpPromptMessage[] }> {
    return await this.requireConnectedServer(server).client.getPrompt(name, args) as { description?: string; messages: import("./types.js").McpPromptMessage[] };
  }

  private matchingRecords(server?: string): Array<ServerRecord & { client: McpClient }> {
    if (server) return [this.requireConnectedServer(server)];
    return [...this.servers.values()].filter((record): record is ServerRecord & { client: McpClient } => record.status.state === "connected" && Boolean(record.client));
  }

  private requireConnectedServer(server: string): ServerRecord & { client: McpClient } {
    const record = this.servers.get(server);
    if (!record) throw new Error(`Unknown MCP server ${server}`);
    if (record.status.state !== "connected" || !record.client) throw new Error(`MCP server ${server} is not connected`);
    return record as ServerRecord & { client: McpClient };
  }

  private async notifyCatalog(kind: "tools" | "resources" | "prompts", server: string): Promise<void> {
    await Promise.all([...this.catalogListeners].map((listener) => listener(kind, server)));
  }
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
}

export function mcpPromptCommandName(server: string, prompt: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(prompt)}`;
}

function runtimeTools(server: string, tools: McpTool[]): RuntimeMcpTool[] {
  return tools.map((tool) => ({ ...tool, server, originalName: tool.name, name: mcpToolName(server, tool.name) }));
}

async function closeClient(client: McpClient | undefined): Promise<string | undefined> {
  try {
    await client?.close?.();
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
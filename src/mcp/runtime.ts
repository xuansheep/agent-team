import type { ResolvedMcpServerConfig } from "./schema.js";
import type { McpClient, McpPrompt, McpResource, McpResourceTemplate, McpServerMetadata, McpTool, McpToolCallResult } from "./types.js";

export const MAX_MCP_RECONNECT_ATTEMPTS = 5;
export const INITIAL_MCP_RECONNECT_BACKOFF_MS = 1_000;
export const MAX_MCP_RECONNECT_BACKOFF_MS = 30_000;

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
  generation: number;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
};

export class McpRuntime {
  private readonly servers = new Map<string, ServerRecord>();
  private readonly catalogListeners = new Set<(kind: "tools" | "resources" | "prompts", server: string) => void | Promise<void>>();
  private readonly statusListeners = new Set<(statuses: McpServerStatus[]) => void>();
  private catalogRevision = 0;
  private closed = false;

  constructor(private readonly options: McpRuntimeOptions) {}

  async connectAll(configs: ResolvedMcpServerConfig[]): Promise<void> {
    this.closed = false;
    await this.removeMissing(configs);
    const replacements = configs.map((config) => {
      const previousClient = this.servers.get(config.name)?.client;
      return { record: this.replaceRecord(config), previousClient };
    });
    await Promise.all(replacements.map(({ previousClient }) => closeClient(previousClient)));
    await Promise.all(replacements.map(({ record }) => this.connectRecord(record)));
  }

  startAll(configs: ResolvedMcpServerConfig[]): void {
    this.closed = false;
    void this.removeMissing(configs);
    for (const config of configs) {
      const previousClient = this.servers.get(config.name)?.client;
      const record = this.replaceRecord(config);
      void closeClient(previousClient).then(() => this.connectRecord(record));
    }
  }

  async connect(config: ResolvedMcpServerConfig): Promise<void> {
    this.closed = false;
    const previousClient = this.servers.get(config.name)?.client;
    const record = this.replaceRecord(config);
    await closeClient(previousClient);
    await this.connectRecord(record);
  }

  async disconnect(name: string, state: McpServerState = "disabled"): Promise<void> {
    const record = this.servers.get(name);
    if (!record) throw new Error(`Unknown MCP server ${name}`);
    record.generation += 1;
    clearReconnectTimer(record);
    const client = record.client;
    record.client = undefined;
    clearCatalog(record);
    record.status = { name, state };
    this.bumpCatalogRevision();
    this.notifyStatus();
    const closeError = await closeClient(client);
    if (closeError) {
      record.status = { name, state, error: closeError };
      this.notifyStatus();
      throw new Error(closeError);
    }
  }

  async reconnect(config: ResolvedMcpServerConfig): Promise<void> {
    await this.connect(config);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const records = [...this.servers.values()];
    const clients = records.map((record) => record.client);
    for (const record of records) {
      record.generation += 1;
      clearReconnectTimer(record);
      record.client = undefined;
      clearCatalog(record);
      record.status = { name: record.config.name, state: "disabled" };
    }
    this.bumpCatalogRevision();
    this.notifyStatus();
    await Promise.all(clients.map((client) => closeClient(client)));
  }

  subscribe(listener: (statuses: McpServerStatus[]) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.listServerStatuses());
    return () => this.statusListeners.delete(listener);
  }

  onCatalogChanged(listener: (kind: "tools" | "resources" | "prompts", server: string) => void | Promise<void>): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  getServerStatus(name: string): McpServerStatus | undefined {
    return this.servers.get(name)?.status;
  }

  listServerStatuses(): McpServerStatus[] {
    return [...this.servers.values()].map((record) => ({ ...record.status })).sort((left, right) => left.name.localeCompare(right.name));
  }

  getCatalogRevision(): number {
    return this.catalogRevision;
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

  private replaceRecord(config: ResolvedMcpServerConfig): ServerRecord {
    const existing = this.servers.get(config.name);
    if (existing) {
      existing.generation += 1;
      clearReconnectTimer(existing);
    }
    const record: ServerRecord = {
      config,
      status: { name: config.name, state: config.disabled ? "disabled" : "pending" },
      metadata: {},
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      generation: (existing?.generation ?? 0) + 1,
      reconnectAttempts: 0
    };
    this.servers.set(config.name, record);
    this.bumpCatalogRevision();
    this.notifyStatus();
    return record;
  }

  private async connectRecord(record: ServerRecord): Promise<void> {
    if (record.config.disabled || this.closed || !this.isCurrent(record)) return;
    const generation = record.generation;
    record.status = { name: record.config.name, state: "pending" };
    this.notifyStatus();
    let client: McpClient | undefined;
    try {
      client = await this.options.clientFactory(record.config);
      await client.initialize?.();
      if (!this.isCurrent(record, generation)) {
        await closeClient(client);
        return;
      }
      record.client = client;
      client.onClose?.(() => { void this.handleUnexpectedClose(record, client!); });
      client.onListChanged?.({
        tools: async (tools) => {
          if (!this.isCurrent(record, generation)) return;
          record.tools = runtimeTools(record.config.name, tools);
          this.bumpCatalogRevision();
          await this.notifyCatalog("tools", record.config.name);
        },
        resources: async (resources) => {
          if (!this.isCurrent(record, generation)) return;
          record.resources = resources.slice();
          record.resourceTemplates = await client!.listResourceTemplates?.() ?? [];
          this.bumpCatalogRevision();
          await this.notifyCatalog("resources", record.config.name);
        },
        prompts: async (prompts) => {
          if (!this.isCurrent(record, generation)) return;
          record.prompts = prompts.slice();
          this.bumpCatalogRevision();
          await this.notifyCatalog("prompts", record.config.name);
        }
      });
      const [tools, resources, resourceTemplates, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listResourceTemplates?.() ?? [],
        client.listPrompts()
      ]);
      if (!this.isCurrent(record, generation)) {
        await closeClient(client);
        return;
      }
      record.metadata = client.getMetadata?.() ?? {};
      record.tools = runtimeTools(record.config.name, tools);
      record.resources = resources;
      record.resourceTemplates = resourceTemplates;
      record.prompts = prompts;
      record.reconnectAttempts = 0;
      record.status = { name: record.config.name, state: "connected" };
      this.bumpCatalogRevision();
      this.notifyStatus();
    } catch (error) {
      await closeClient(client);
      if (!this.isCurrent(record, generation)) return;
      record.client = undefined;
      clearCatalog(record);
      record.status = { name: record.config.name, state: "failed", error: errorMessage(error) };
      this.bumpCatalogRevision();
      this.notifyStatus();
      this.scheduleReconnect(record);
    }
  }

  private async handleUnexpectedClose(record: ServerRecord, client: McpClient): Promise<void> {
    if (record.client !== client || !this.isCurrent(record) || this.closed) return;
    record.client = undefined;
    clearCatalog(record);
    record.status = { name: record.config.name, state: "failed", error: "MCP connection closed unexpectedly" };
    this.bumpCatalogRevision();
    this.notifyStatus();
    this.scheduleReconnect(record);
  }

  private scheduleReconnect(record: ServerRecord): void {
    if (
      this.closed
      || record.config.type === "stdio"
      || record.config.disabled
      || !this.isCurrent(record)
      || record.reconnectAttempts >= MAX_MCP_RECONNECT_ATTEMPTS
      || record.reconnectTimer
    ) return;
    const attempt = record.reconnectAttempts;
    const delay = Math.min(MAX_MCP_RECONNECT_BACKOFF_MS, INITIAL_MCP_RECONNECT_BACKOFF_MS * (2 ** attempt));
    record.reconnectAttempts += 1;
    const generation = record.generation;
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = undefined;
      if (!this.isCurrent(record, generation)) return;
      void this.connectRecord(record);
    }, delay);
    record.reconnectTimer.unref?.();
  }

  private async removeMissing(configs: ResolvedMcpServerConfig[]): Promise<void> {
    const nextNames = new Set(configs.map((config) => config.name));
    const removed = [...this.servers.entries()].filter(([name]) => !nextNames.has(name));
    for (const [name, record] of removed) {
      record.generation += 1;
      clearReconnectTimer(record);
      this.servers.delete(name);
      await closeClient(record.client);
      this.bumpCatalogRevision();
    }
    if (removed.length) this.notifyStatus();
  }

  private isCurrent(record: ServerRecord, generation = record.generation): boolean {
    return this.servers.get(record.config.name) === record && record.generation === generation;
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

  private notifyStatus(): void {
    const statuses = this.listServerStatuses();
    for (const listener of this.statusListeners) listener(statuses);
  }

  private bumpCatalogRevision(): void {
    this.catalogRevision += 1;
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

function clearCatalog(record: ServerRecord): void {
  record.metadata = {};
  record.tools = [];
  record.resources = [];
  record.resourceTemplates = [];
  record.prompts = [];
}

function clearReconnectTimer(record: ServerRecord): void {
  if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
  record.reconnectTimer = undefined;
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

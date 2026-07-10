import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { ElicitRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpServerConfig } from "./schema.js";
import type { McpClient, McpListChangedHandlers, McpPrompt, McpResource, McpResourceTemplate, McpServerMetadata, McpTool, McpToolCallResult } from "./types.js";

export type McpClientFactory = (server: ResolvedMcpServerConfig) => Promise<McpClient>;

export type McpElicitationRequest = Record<string, unknown>;
export type McpElicitationResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

export type McpTransportFactoryOptions = {
  createClient?: McpClientFactory;
  roots?: () => Array<{ uri: string; name?: string }>;
  elicit?: (request: McpElicitationRequest) => Promise<McpElicitationResult>;
};

const defaultTimeoutMs = 30_000;

export function createMcpClientFactory(options: McpTransportFactoryOptions = {}): McpClientFactory {
  if (options.createClient) return options.createClient;
  return async (server) => new SdkMcpClient(server, createTransport(server), options);
}

class SdkMcpClient implements McpClient {
  private readonly client: Client;
  private handlers: McpListChangedHandlers = {};
  private connected = false;

  constructor(
    private readonly server: ResolvedMcpServerConfig,
    private readonly transport: Transport,
    private readonly options: McpTransportFactoryOptions
  ) {
    const capabilities = {
      ...(options.roots ? { roots: { listChanged: true } } : {}),
      ...(options.elicit ? { elicitation: { form: {}, url: {} } } : {})
    };
    this.client = new Client(
      { name: "agent-team", version: "0.1.0" },
      {
        capabilities,
        listChanged: {
          tools: { onChanged: (error, tools) => { if (!error && tools) void this.handlers.tools?.(tools as McpTool[]); } },
          resources: { onChanged: (error, resources) => { if (!error && resources) void this.handlers.resources?.(resources as McpResource[]); } },
          prompts: { onChanged: (error, prompts) => { if (!error && prompts) void this.handlers.prompts?.(prompts as McpPrompt[]); } }
        }
      }
    );
    if (options.roots) {
      this.client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: options.roots!().map((root) => ({ uri: normalizeRootUri(root.uri), ...(root.name ? { name: root.name } : {}) }))
      }));
    }
    if (options.elicit) {
      this.client.setRequestHandler(ElicitRequestSchema, async (request) => options.elicit!(request.params as McpElicitationRequest));
    }
  }

  async initialize(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport, requestOptions(this.server));
    this.connected = true;
  }

  getMetadata(): McpServerMetadata {
    return {
      capabilities: this.client.getServerCapabilities() as Record<string, unknown> | undefined,
      serverInfo: this.client.getServerVersion(),
      instructions: this.client.getInstructions()
    };
  }

  onListChanged(handlers: McpListChangedHandlers): void {
    this.handlers = handlers;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.supports("tools")) return [];
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, requestOptions(this.server));
      tools.push(...result.tools as McpTool[]);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, input: unknown): Promise<McpToolCallResult> {
    const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    return await this.client.callTool({ name, arguments: args }, undefined, requestOptions(this.server)) as McpToolCallResult;
  }

  async listResources(): Promise<McpResource[]> {
    if (!this.supports("resources")) return [];
    const resources: McpResource[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listResources(cursor ? { cursor } : undefined, requestOptions(this.server));
      resources.push(...result.resources as McpResource[]);
      cursor = result.nextCursor;
    } while (cursor);
    return resources;
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    if (!this.supports("resources")) return [];
    const templates: McpResourceTemplate[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listResourceTemplates(cursor ? { cursor } : undefined, requestOptions(this.server));
      templates.push(...result.resourceTemplates as McpResourceTemplate[]);
      cursor = result.nextCursor;
    } while (cursor);
    return templates;
  }

  async readResource(uri: string) {
    return await this.client.readResource({ uri }, requestOptions(this.server));
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.supports("prompts")) return [];
    const prompts: McpPrompt[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listPrompts(cursor ? { cursor } : undefined, requestOptions(this.server));
      prompts.push(...result.prompts as McpPrompt[]);
      cursor = result.nextCursor;
    } while (cursor);
    return prompts;
  }

  async getPrompt(name: string, args: Record<string, unknown>) {
    return await this.client.getPrompt({ name, arguments: stringArguments(args) }, requestOptions(this.server));
  }

  async close(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }

  private supports(capability: "tools" | "resources" | "prompts"): boolean {
    return Boolean(this.client.getServerCapabilities()?.[capability]);
  }
}

function createTransport(server: ResolvedMcpServerConfig): Transport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: mergedEnvironment(server.env),
      stderr: "pipe"
    });
  }
  const url = new URL(server.url);
  if (server.type === "http") {
    return new StreamableHTTPClientTransport(url, { requestInit: { headers: server.headers } });
  }
  if (server.type === "sse") {
    return new SSEClientTransport(url, {
      requestInit: { headers: server.headers },
      fetch: fetchWithHeaders(server.headers)
    });
  }
  if (server.headers && Object.keys(server.headers).length) throw new Error(`MCP WebSocket server ${server.name} cannot use custom headers with the official transport`);
  return new WebSocketClientTransport(url);
}

function requestOptions(server: ResolvedMcpServerConfig): { timeout: number } {
  return { timeout: server.timeoutMs ?? defaultTimeoutMs };
}

function mergedEnvironment(extra: Record<string, string> | undefined): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { ...inherited, ...(extra ?? {}) };
}

function fetchWithHeaders(headers: Record<string, string> | undefined): typeof fetch {
  return (input, init) => fetch(input, { ...init, headers: { ...headersFrom(init?.headers), ...(headers ?? {}) } });
}

function headersFrom(headers: HeadersInit | undefined): Record<string, string> {
  return headers ? Object.fromEntries(new Headers(headers).entries()) : {};
}

function normalizeRootUri(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return pathToFileURL(value).toString();
  }
}

function stringArguments(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}
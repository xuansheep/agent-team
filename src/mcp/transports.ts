import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fetch, WebSocket } from "undici";
import type { RemoteMcpServerConfig, ResolvedMcpServerConfig, StdioMcpServerConfig } from "./schema.js";
import type { McpClient, McpPrompt, McpResource, McpTool } from "./types.js";

export type McpClientFactory = (server: ResolvedMcpServerConfig) => Promise<McpClient>;

export type McpTransportFactoryOptions = {
  createClient?: McpClientFactory;
};

export type JsonRpcTransport = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void>;
  close?(): Promise<void>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type ResolvedServerFields = Pick<ResolvedMcpServerConfig, "name" | "source">;
type ResolvedStdioMcpServerConfig = StdioMcpServerConfig & ResolvedServerFields;
type ResolvedRemoteMcpServerConfig = RemoteMcpServerConfig & ResolvedServerFields;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export class JsonRpcMcpClient implements McpClient {
  private initialized = false;

  constructor(private readonly transport: JsonRpcTransport) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.transport.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-team", version: "0.1.0" }
    });
    await this.transport.notify?.("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.transport.request("tools/list") as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    return this.transport.request("tools/call", { name, arguments: input });
  }

  async listResources(): Promise<McpResource[]> {
    const result = await this.transport.request("resources/list") as { resources?: McpResource[] };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<unknown> {
    return this.transport.request("resources/read", { uri });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.transport.request("prompts/list") as { prompts?: McpPrompt[] };
    return result.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.transport.request("prompts/get", { name, arguments: args });
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

export function createMcpClientFactory(options: McpTransportFactoryOptions = {}): McpClientFactory {
  if (options.createClient) return options.createClient;
  return async (server) => {
    switch (server.type) {
      case "stdio":
        return new JsonRpcMcpClient(new StdioJsonRpcTransport(server));
      case "http":
        return new JsonRpcMcpClient(new HttpJsonRpcTransport(server));
      case "sse":
        return new JsonRpcMcpClient(new SseJsonRpcTransport(server));
      case "ws":
        return new JsonRpcMcpClient(await WebSocketJsonRpcTransport.connect(server));
    }
  };
}

export class HttpJsonRpcTransport implements JsonRpcTransport {
  protected nextId = 1;

  constructor(private readonly server: ResolvedRemoteMcpServerConfig) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs(this.server));
    try {
      const response = await fetch(this.server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.server.headers ?? {})
        },
        body: JSON.stringify(jsonRpcRequest(this.nextId++, method, params)),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`MCP ${this.server.name} request failed ${response.status}: ${text}`);
      return jsonRpcResult(JSON.parse(text) as JsonRpcResponse);
    } catch (error) {
      throw normalizedTimeoutError(error, this.server);
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs(this.server));
    try {
      const response = await fetch(this.server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.server.headers ?? {})
        },
        body: JSON.stringify(jsonRpcNotification(method, params)),
        signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`MCP ${this.server.name} notification failed ${response.status}: ${text}`);
      }
    } catch (error) {
      throw normalizedTimeoutError(error, this.server);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SseJsonRpcTransport extends HttpJsonRpcTransport {
  constructor(private readonly sseServer: ResolvedRemoteMcpServerConfig) {
    super(sseServer);
  }

  override async request(method: string, params?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs(this.sseServer));
    try {
      const response = await fetch(this.sseServer.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
          ...(this.sseServer.headers ?? {})
        },
        body: JSON.stringify(jsonRpcRequest(this.nextId++, method, params)),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`MCP ${this.sseServer.name} request failed ${response.status}: ${text}`);
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("text/event-stream") ? firstSseData(text) : text;
      return jsonRpcResult(JSON.parse(payload) as JsonRpcResponse);
    } catch (error) {
      throw normalizedTimeoutError(error, this.sseServer);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);

  constructor(private readonly server: ResolvedStdioMcpServerConfig) {
    this.child = spawn(server.command, server.args ?? [], {
      cwd: server.cwd,
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: "pipe"
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => this.rejectAll(new Error(`MCP stdio server ${server.name} exited with ${code ?? "unknown"}`)));
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message = JSON.stringify(jsonRpcRequest(id, method, params));
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n\r\n${message}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(timeoutMessage(this.server)));
      }, timeoutMs(this.server));
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.writeMessage(jsonRpcNotification(method, params));
  }

  async close(): Promise<void> {
    this.child.kill();
  }

  private writeMessage(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private readStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.rejectAll(new Error(`Invalid MCP stdio frame from ${this.server.name}`));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.resolveResponse(JSON.parse(body) as JsonRpcResponse);
    }
  }

  private resolveResponse(response: JsonRpcResponse): void {
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    try {
      pending.resolve(jsonRpcResult(response));
    } catch (error) {
      pending.reject(error);
    }
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class WebSocketJsonRpcTransport implements JsonRpcTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly server: ResolvedRemoteMcpServerConfig, private readonly socket: WebSocket) {
    this.socket.addEventListener("message", (event) => this.resolveMessage((event as { data: unknown }).data));
    this.socket.addEventListener("error", () => this.rejectAll(new Error(`MCP WebSocket server ${server.name} failed`)));
    this.socket.addEventListener("close", () => this.rejectAll(new Error(`MCP WebSocket server ${server.name} closed`)));
  }

  static async connect(server: ResolvedRemoteMcpServerConfig): Promise<WebSocketJsonRpcTransport> {
    const socket = new WebSocket(server.url, { headers: server.headers });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(timeoutMessage(server)));
      }, timeoutMs(server));
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`MCP WebSocket server ${server.name} failed to open`));
      }, { once: true });
    });
    return new WebSocketJsonRpcTransport(server, socket);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify(jsonRpcRequest(id, method, params)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(timeoutMessage(this.server)));
      }, timeoutMs(this.server));
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.socket.send(JSON.stringify(jsonRpcNotification(method, params)));
  }

  async close(): Promise<void> {
    this.socket.close();
  }

  private resolveMessage(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
    const response = JSON.parse(text) as JsonRpcResponse;
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    try {
      pending.resolve(jsonRpcResult(response));
    } catch (error) {
      pending.reject(error);
    }
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function jsonRpcRequest(id: number, method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {})
  };
}

function jsonRpcNotification(method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {})
  };
}

function jsonRpcResult(response: JsonRpcResponse): unknown {
  if (response.error) throw new Error(response.error.message ?? `MCP JSON-RPC error ${response.error.code ?? "unknown"}`);
  return response.result;
}

function timeoutMs(server: ResolvedMcpServerConfig): number {
  return server.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
}

function timeoutMessage(server: ResolvedMcpServerConfig): string {
  return `MCP ${server.name} request timed out after ${timeoutMs(server)}ms`;
}

function normalizedTimeoutError(error: unknown, server: ResolvedMcpServerConfig): Error {
  if (error instanceof Error && error.name === "AbortError") return new Error(timeoutMessage(server));
  return error instanceof Error ? error : new Error(String(error));
}

function firstSseData(text: string): string {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data && data !== "[DONE]") return data;
  }
  throw new Error("MCP SSE response did not contain data");
}

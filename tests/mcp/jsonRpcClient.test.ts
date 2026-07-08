import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HttpJsonRpcTransport,
  JsonRpcMcpClient,
  SseJsonRpcTransport,
  StdioJsonRpcTransport,
  type JsonRpcTransport
} from "../../src/mcp/transports.js";

class FakeJsonRpcTransport implements JsonRpcTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } };
    if (method === "tools/list") return { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] };
    if (method === "tools/call") return { content: [{ type: "text", text: "ok" }] };
    if (method === "resources/list") return { resources: [{ uri: "file://readme", name: "Readme" }] };
    if (method === "resources/read") return { uri: "file://readme", contents: [{ type: "text", text: "hello" }] };
    if (method === "prompts/list") return { prompts: [{ name: "explain", description: "Explain" }] };
    if (method === "prompts/get") return { name: "explain", messages: [{ role: "user", content: "Explain MCP" }] };
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }
}

describe("JsonRpcMcpClient", () => {
  it("performs MCP initialize before protocol calls when requested", async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new JsonRpcMcpClient(transport);

    await client.initialize();
    assert.equal((await client.listTools())[0]?.name, "search");

    assert.equal(transport.calls[0]?.method, "initialize");
    assert.equal(transport.calls[1]?.method, "tools/list");
    assert.deepEqual(transport.notifications, [{ method: "notifications/initialized", params: undefined }]);
  });

  it("maps MCP client methods to JSON-RPC protocol methods", async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new JsonRpcMcpClient(transport);

    assert.equal((await client.listTools())[0]?.name, "search");
    assert.deepEqual(await client.callTool("search", { q: "abc" }), { content: [{ type: "text", text: "ok" }] });
    assert.equal((await client.listResources())[0]?.uri, "file://readme");
    assert.deepEqual(await client.readResource("file://readme"), { uri: "file://readme", contents: [{ type: "text", text: "hello" }] });
    assert.equal((await client.listPrompts())[0]?.name, "explain");
    assert.deepEqual(await client.getPrompt("explain", { topic: "MCP" }), { name: "explain", messages: [{ role: "user", content: "Explain MCP" }] });

    assert.deepEqual(transport.calls, [
      { method: "tools/list", params: undefined },
      { method: "tools/call", params: { name: "search", arguments: { q: "abc" } } },
      { method: "resources/list", params: undefined },
      { method: "resources/read", params: { uri: "file://readme" } },
      { method: "prompts/list", params: undefined },
      { method: "prompts/get", params: { name: "explain", arguments: { topic: "MCP" } } }
    ]);
  });

  it("posts JSON-RPC over HTTP", async () => {
    const seen: Array<{ method: string; params?: unknown; header?: string }> = [];
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request)) as { id: number; method: string; params?: unknown };
      seen.push({ method: body.method, params: body.params, header: request.headers["x-mcp-test"] as string | undefined });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "http_tool" }] } }));
    });
    await listen(server);
    const client = new JsonRpcMcpClient(new HttpJsonRpcTransport({
      name: "http",
      source: "project",
      type: "http",
      url: localUrl(server),
      headers: { "x-mcp-test": "yes" }
    }));

    try {
      assert.equal((await client.listTools())[0]?.name, "http_tool");
      assert.deepEqual(seen, [{ method: "tools/list", params: undefined, header: "yes" }]);
    } finally {
      await close(server);
    }
  });

  it("parses single-response SSE JSON-RPC payloads", async () => {
    const server = createServer(async (request, response) => {
      const body = JSON.parse(await readRequestBody(request)) as { id: number };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { resources: [{ uri: "file://sse" }] } })}\n\n`);
    });
    await listen(server);
    const client = new JsonRpcMcpClient(new SseJsonRpcTransport({
      name: "sse",
      source: "project",
      type: "sse",
      url: localUrl(server)
    }));

    try {
      assert.equal((await client.listResources())[0]?.uri, "file://sse");
    } finally {
      await close(server);
    }
  });

  it("uses Content-Length framing over stdio", { timeout: 3000 }, async (t) => {
    let transport: StdioJsonRpcTransport;
    try {
      transport = new StdioJsonRpcTransport({
        name: "stdio",
        source: "project",
        type: "stdio",
        command: process.execPath,
        args: ["-e", stdioServerSource()]
      });
    } catch (error) {
      if (isSpawnBlocked(error)) {
        t.skip("child_process.spawn is blocked in this sandbox");
        return;
      }
      throw error;
    }
    const client = new JsonRpcMcpClient(transport);

    try {
      assert.equal((await client.listTools())[0]?.name, "stdio_tool");
      assert.deepEqual(await client.callTool("stdio_tool", { value: 1 }), { echo: { value: 1 } });
    } finally {
      await client.close();
    }
  });

  it("initializes a real stdio MCP server before listing and calling tools", { timeout: 3000 }, async (t) => {
    let transport: StdioJsonRpcTransport;
    try {
      transport = new StdioJsonRpcTransport({
        name: "stdio",
        source: "project",
        type: "stdio",
        command: process.execPath,
        args: ["-e", initializingStdioServerSource()]
      });
    } catch (error) {
      if (isSpawnBlocked(error)) {
        t.skip("child_process.spawn is blocked in this sandbox");
        return;
      }
      throw error;
    }
    const client = new JsonRpcMcpClient(transport);

    try {
      await client.initialize();
      assert.equal((await client.listTools())[0]?.name, "stdio_tool");
      const result = await client.callTool("stdio_tool", { value: 7 }) as { echo?: unknown; calls?: string[] };

      assert.deepEqual(result.echo, { value: 7 });
      assert.equal(result.calls?.[0], "initialize");
      assert.ok(result.calls?.includes("notifications/initialized"));
      assert.ok((result.calls?.indexOf("tools/list") ?? -1) > (result.calls?.indexOf("initialize") ?? -1));
      assert.ok((result.calls?.indexOf("tools/call") ?? -1) > (result.calls?.indexOf("tools/list") ?? -1));
    } catch (error) {
      if (isSpawnBlocked(error)) {
        t.skip("child_process.spawn is blocked in this sandbox");
        return;
      }
      throw error;
    } finally {
      await client.close();
    }
  });
});

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function localUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

function isSpawnBlocked(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}

function stdioServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) throw new Error("missing content length");
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const request = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    send({ jsonrpc: "2.0", id: request.id, result: resultFor(request.method, request.params) });
  }
}
function resultFor(method, params) {
  if (method === "tools/list") return { tools: [{ name: "stdio_tool" }] };
  if (method === "tools/call") return { echo: params.arguments };
  return {};
}
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}
`;
}

function initializingStdioServerSource(): string {
  return `
let buffer = Buffer.alloc(0);
let initialized = false;
const calls = [];
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});
function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) throw new Error("missing content length");
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const request = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
    buffer = buffer.subarray(bodyEnd);
    calls.push(request.method);
    if (request.method === "notifications/initialized") {
      initialized = true;
      continue;
    }
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "fake-stdio", version: "1.0.0" }
      } });
      continue;
    }
    if (!initialized) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "not initialized" } });
      continue;
    }
    send({ jsonrpc: "2.0", id: request.id, result: resultFor(request.method, request.params) });
  }
}
function resultFor(method, params) {
  if (method === "tools/list") return { tools: [{ name: "stdio_tool", inputSchema: { type: "object" } }] };
  if (method === "resources/list") return { resources: [{ uri: "file://stdio", name: "stdio" }] };
  if (method === "prompts/list") return { prompts: [{ name: "stdio_prompt", description: "stdio prompt" }] };
  if (method === "tools/call") return { echo: params.arguments, calls };
  return {};
}
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body);
}
`;
}

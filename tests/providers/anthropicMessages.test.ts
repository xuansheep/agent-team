import { createServer, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnthropicMessagesProvider } from "../../src/providers/anthropicMessages.js";
import { Tool } from "../../src/tools/types.js";

const servers: Array<{ close: () => Promise<void> }> = [];
const responseSchema = { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false };
const tool: Tool = {
  name: "Bash",
  description: "Run a command",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  async execute() {
    return { output: "" };
  }
};
const context = {
  runId: "run-1",
  nodeId: "dev",
  attempt: 1,
  sessionId: "run-1",
  threadId: "run-1:dev",
  turnId: "run-1:dev:1",
  promptCacheKey: "a".repeat(64)
};

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("AnthropicMessagesProvider", () => {
  it("sends Anthropic Messages request bodies and headers", async () => {
    const server = await startJsonServer({ content: [{ type: "text", text: "{\"status\":\"success\"}" }] });
    const provider = new AnthropicMessagesProvider({
      baseUrl: server.baseUrl,
      apiKey: "test-key",
      version: "2023-06-01",
      betaHeaders: ["messages-test-beta"],
      maxTokens: 4096,
      jsonSchemaOutput: true,
      thinking: { type: "enabled", budget_tokens: 1024 }
    });

    const result = await provider.generate({
      model: "claude-test",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "hello" }
      ],
      tools: [tool],
      response_schema: responseSchema,
      context
    });

    assert.equal(result.content, "{\"status\":\"success\"}");
    assert.equal(server.requestPath, "/v1/messages");
    assert.equal(server.requestHeaders["x-api-key"], "test-key");
    assert.equal(server.requestHeaders["anthropic-version"], "2023-06-01");
    assert.equal(server.requestHeaders["anthropic-beta"], "messages-test-beta");
    assert.deepEqual(server.requestBody.system, [{ type: "text", text: "System prompt", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(server.requestBody.messages, [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }]);
    assert.deepEqual(server.requestBody.tools, [{ name: "Bash", description: "Run a command", input_schema: tool.input_schema }]);
    assert.deepEqual(server.requestBody.tool_choice, { type: "auto" });
    assert.equal(server.requestBody.max_tokens, 4096);
    assert.deepEqual(server.requestBody.metadata, {
      user_id: JSON.stringify({ session_id: "run-1", thread_id: "run-1:dev", turn_id: "run-1:dev:1" })
    });
    assert.deepEqual(server.requestBody.thinking, { type: "enabled", budget_tokens: 1024 });
    assert.deepEqual(server.requestBody.output_config, {
      format: { type: "json_schema", schema: responseSchema }
    });
  });

  it("omits Anthropic prompt cache controls when disabled", async () => {
    const server = await startJsonServer({ content: [{ type: "text", text: "ok" }] });
    const provider = new AnthropicMessagesProvider({ baseUrl: server.baseUrl, apiKey: "test-key", version: "2023-06-01", maxTokens: 1024, promptCache: false });

    await provider.generate({
      model: "claude-test",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "hello" }
      ],
      tools: []
    });

    assert.deepEqual(server.requestBody.system, [{ type: "text", text: "System prompt" }]);
    assert.deepEqual(server.requestBody.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it("supports bearer API key mode overrides", async () => {
    const server = await startJsonServer({ content: [{ type: "text", text: "ok" }] });
    const provider = new AnthropicMessagesProvider({
      baseUrl: server.baseUrl,
      apiKey: "test-key",
      apiKeyMode: "bearer",
      version: "2023-06-01",
      maxTokens: 1024
    });

    await provider.generate({ model: "claude-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.equal(server.requestHeaders.authorization, "Bearer test-key");
    assert.equal(server.requestHeaders["x-api-key"], undefined);
  });

  it("maps images, tool uses, and tool results", async () => {
    const server = await startJsonServer({ content: [{ type: "tool_use", id: "toolu-2", name: "Bash", input: { command: "pwd" } }] });
    const provider = new AnthropicMessagesProvider({ baseUrl: server.baseUrl, apiKey: "test-key", version: "2023-06-01", maxTokens: 1024 });

    const result = await provider.generate({
      model: "claude-test",
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", media_type: "image/png", data: "abc" }] },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu-1", name: "Bash", input: { command: "ls" } }] },
        { role: "tool", tool_call_id: "toolu-1", content: JSON.stringify({ output: "package.json" }) }
      ],
      tools: []
    });

    assert.deepEqual(server.requestBody.messages, [
      { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-1", content: JSON.stringify({ output: "package.json" }), cache_control: { type: "ephemeral" } }] }
    ]);
    assert.deepEqual(result.tool_calls, [{ id: "toolu-2", name: "Bash", input: { command: "pwd" } }]);
  });

  it("keeps multiple tool results in one immediate user message", async () => {
    const server = await startJsonServer({ content: [{ type: "text", text: "ok" }] });
    const provider = new AnthropicMessagesProvider({ baseUrl: server.baseUrl, apiKey: "test-key", version: "2023-06-01", maxTokens: 1024 });

    await provider.generate({
      model: "claude-test",
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", content: "", tool_calls: [
          { id: "toolu-1", name: "Bash", input: { command: "pwd" } },
          { id: "toolu-2", name: "Bash", input: { command: "ls" } }
        ] },
        { role: "tool", tool_call_id: "toolu-1", content: JSON.stringify({ output: "root" }) },
        { role: "tool", tool_call_id: "toolu-2", content: JSON.stringify({ output: "package.json" }) }
      ],
      tools: []
    });

    assert.deepEqual(server.requestBody.messages, [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "pwd" } },
        { type: "tool_use", id: "toolu-2", name: "Bash", input: { command: "ls" } }
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu-1", content: JSON.stringify({ output: "root" }) },
        { type: "tool_result", tool_use_id: "toolu-2", content: JSON.stringify({ output: "package.json" }), cache_control: { type: "ephemeral" } }
      ] }
    ]);
  });

  it("streams text deltas and tool input deltas", async () => {
    const server = await startSseServer([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{\"status\":" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\"success\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu-1", name: "Bash", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"npm test\"}" } },
      { type: "content_block_stop", index: 1 },
      "[DONE]"
    ]);
    const provider = new AnthropicMessagesProvider({ baseUrl: server.baseUrl, apiKey: "test-key", version: "2023-06-01", maxTokens: 1024, streaming: true });
    const deltas: string[] = [];

    const result = await provider.stream?.(
      { model: "claude-test", messages: [{ role: "user", content: "hello" }], tools: [] },
      (event) => deltas.push(event.text)
    );

    assert.deepEqual(deltas, ["{\"status\":", "\"success\"}"]);
    assert.equal(result?.content, "{\"status\":\"success\"}");
    assert.deepEqual(result?.tool_calls, [{ id: "toolu-1", name: "Bash", input: { command: "npm test" } }]);
    assert.equal(server.requestBody.stream, true);
    assert.deepEqual(server.requestBody.messages, [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }]);
  });
});

async function startJsonServer(responseBody: unknown): Promise<{ baseUrl: string; requestPath: string; requestBody: Record<string, unknown>; requestHeaders: IncomingHttpHeaders; close: () => Promise<void> }> {
  let requestPath = "";
  let requestBody: Record<string, unknown> = {};
  let requestHeaders: IncomingHttpHeaders = {};
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? "";
    requestHeaders = request.headers;
    requestBody = await readJsonBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}`, get requestPath() { return requestPath; }, get requestBody() { return requestBody; }, get requestHeaders() { return requestHeaders; }, close };
  servers.push(handle);
  return handle;
}

async function startSseServer(events: Array<unknown | "[DONE]">): Promise<{ baseUrl: string; requestBody: Record<string, unknown>; close: () => Promise<void> }> {
  let requestBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    requestBody = await readJsonBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
      response.write(`data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`);
    }
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}`, get requestBody() { return requestBody; }, close };
  servers.push(handle);
  return handle;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

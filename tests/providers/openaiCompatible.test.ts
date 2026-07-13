import { createServer, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider, toOpenAiMessages } from "../../src/providers/openaiCompatible.js";
import type { Tool } from "../../src/tools/types.js";

const servers: Array<{ close: () => Promise<void> }> = [];
const responseSchema = { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false };
const promptedTool: Tool = {
  name: "PromptedTool",
  description: "Short provider description",
  prompt: "Long model-facing tool prompt that belongs only in runtime attachments.",
  input_schema: { type: "object", properties: {} },
  async execute() {
    return { output: "" };
  }
};

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("toOpenAiMessages", () => {


  it("serializes assistant tool calls before tool outputs", () => {
    const messages = toOpenAiMessages([
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "LS", input: { path: "." } }] },
      { role: "tool", tool_call_id: "call-1", content: JSON.stringify({ output: "package.json" }) }
    ]);

    assert.deepEqual(messages, [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "LS", arguments: JSON.stringify({ path: "." }) }
          }
        ]
      },
      { role: "tool", content: JSON.stringify({ output: "package.json" }), tool_call_id: "call-1" }
    ]);
  });


  it("keeps text and image content in one user message", () => {
    const messages = toOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Review this design" },
          { type: "image", media_type: "image/png", data: "abc" }
        ]
      }
    ]) as Array<{ content: unknown }>;

    assert.deepEqual(messages[0].content, [
      { type: "text", text: "Review this design" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
    ]);
  });
});

describe("OpenAiCompatibleProvider structured output", () => {


  it("sends a Claude Code compatible user-agent by default", async () => {
    const server = await startJsonServer({ choices: [{ message: { content: "{\"direction\":\"forward\"}" } }] });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.equal(server.requestHeaders["user-agent"], "claude-code/2.1.186");
  });

  it("keeps long tool prompts out of OpenAI-compatible tool schemas", async () => {
    const server = await startJsonServer({ choices: [{ message: { content: "{\"direction\":\"forward\"}" } }] });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [promptedTool] });

    assert.deepEqual(server.requestBody.tools, [{
      type: "function",
      function: {
        name: "PromptedTool",
        description: "Short provider description",
        parameters: promptedTool.input_schema
      }
    }]);
    assert.doesNotMatch(JSON.stringify(server.requestBody), /Long model-facing tool prompt/);
  });

  it("allows provider user-agent override", async () => {
    const server = await startJsonServer({ choices: [{ message: { content: "{\"direction\":\"forward\"}" } }] });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key", userAgent: "custom-agent/1.0" });

    await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.equal(server.requestHeaders["user-agent"], "custom-agent/1.0");
  });

  it("sends json_schema response_format for non-streaming requests when enabled", async () => {
    const server = await startJsonServer({ choices: [{ message: { content: "{\"direction\":\"forward\"}" } }] });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key", jsonSchemaOutput: true });

    await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [], response_schema: responseSchema });

    assert.deepEqual(server.requestBody.response_format, {
      type: "json_schema",
      json_schema: { name: "node_result", strict: true, schema: responseSchema }
    });
  });

  it("maps OpenAI-compatible reasoning_content into normalized thinking text", async () => {
    const server = await startJsonServer({ choices: [{ message: { reasoning_content: "Checked constraints.", content: "{\"direction\":\"forward\"}" } }] });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    const result = await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.equal(result.thinking, "Checked constraints.");
    assert.equal(result.content, "{\"direction\":\"forward\"}");
  });

  it("maps usage and finish reason into normalized response metadata", async () => {
    const server = await startJsonServer({
      choices: [{ finish_reason: "tool_calls", message: { content: "checking" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    const result = await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    assert.equal(result.stopReason, "tool_call");
  });

  it("retries transient network failures for non-streaming requests", async () => {
    const server = await startFlakyJsonServer({ choices: [{ message: { content: "{\"direction\":\"forward\"}" } }] });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    const result = await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.equal(result.content, "{\"direction\":\"forward\"}");
    assert.equal(server.attempts, 2);
  });

  it("reports endpoint, attempts, and cause details after network retries are exhausted", async () => {
    const server = await startNetworkFailureServer();
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    await assert.rejects(
      () => provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.match((error as Error).message, /Provider network request failed after 5 attempts/);
        const detail = (error as { detail?: string }).detail ?? "";
        assert.match(detail, /endpoint: .*\/chat\/completions/);
        assert.match(detail, /attempts: 5/);
        assert.match(detail, /cause\./);
        return true;
      }
    );
    assert.equal(server.attempts, 5);
  });

  it("does not retry provider HTTP errors", async () => {
    const server = await startStatusServer(401, "missing Authorization");
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    await assert.rejects(
      () => provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] }),
      /Provider request failed 401: missing Authorization/
    );
    assert.equal(server.attempts, 1);
  });
});

describe("OpenAiCompatibleProvider streaming", () => {
  it("does not expose streaming unless it is enabled", () => {
    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-key" });

    assert.equal(provider.stream, undefined);
  });

  it("streams content deltas and returns the aggregated response", async () => {
    const server = await startSseServer([
      { choices: [{ delta: { content: "{\"direction\":\"forward\"," } }] },
      { choices: [{ delta: { content: "\"summary\":\"done\"}" } }] },
      "[DONE]"
    ]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true, jsonSchemaOutput: true });
    const deltas: string[] = [];

    const result = await provider.stream?.(
      { model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [], response_schema: responseSchema },
      (event) => {
        if (event.type === "content_delta") deltas.push(event.text);
      }
    );

    assert.deepEqual(deltas, ["{\"direction\":\"forward\",", "\"summary\":\"done\"}"]);
    assert.equal(result?.content, "{\"direction\":\"forward\",\"summary\":\"done\"}");
    assert.equal(server.requestBody.stream, true);
    assert.deepEqual(server.requestBody.response_format, {
      type: "json_schema",
      json_schema: { name: "node_result", strict: true, schema: responseSchema }
    });
  });

  it("streams reasoning_content deltas as normalized thinking events", async () => {
    const server = await startSseServer([
      { choices: [{ delta: { reasoning_content: "Checked " } }] },
      { choices: [{ delta: { reasoning_content: "constraints.", content: "{\"direction\":\"forward\"}" } }] },
      "[DONE]"
    ]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });
    const thinking: string[] = [];

    const result = await provider.stream?.(
      { model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] },
      (event) => {
        if (event.type === "thinking_delta") thinking.push(event.text);
      }
    );

    assert.deepEqual(thinking, ["Checked ", "constraints."]);
    assert.equal(result?.thinking, "Checked constraints.");
    assert.equal(result?.content, "{\"direction\":\"forward\"}");
  });

  it("aggregates streamed tool call argument fragments", async () => {
    const server = await startSseServer([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "Bash", arguments: "{\"command\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"npm test\"}" } }] } }] },
      "[DONE]"
    ]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });

    const result = await provider.stream?.({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] }, () => undefined);

    assert.deepEqual(result?.tool_calls, [{ id: "call-1", name: "Bash", input: { command: "npm test" } }]);
  });

  it("retries transient network failures before reading a stream", async () => {
    const server = await startFlakySseServer([
      { choices: [{ delta: { content: "{\"direction\":\"forward\"}" } }] },
      "[DONE]"
    ]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });
    const deltas: string[] = [];

    const result = await provider.stream?.(
      { model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] },
      (event) => {
        if (event.type === "content_delta") deltas.push(event.text);
      }
    );

    assert.deepEqual(deltas, ["{\"direction\":\"forward\"}"]);
    assert.equal(result?.content, "{\"direction\":\"forward\"}");
    assert.equal(server.attempts, 2);
  });
});

async function startJsonServer(responseBody: unknown): Promise<{ baseUrl: string; requestBody: Record<string, unknown>; requestHeaders: IncomingHttpHeaders; close: () => Promise<void> }> {
  let requestBody: Record<string, unknown> = {};
  let requestHeaders: IncomingHttpHeaders = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      requestHeaders = request.headers;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requestBody() { return requestBody; }, get requestHeaders() { return requestHeaders; }, close };
  servers.push(handle);
  return handle;
}

async function startSseServer(events: Array<unknown | "[DONE]">): Promise<{ baseUrl: string; requestBody: Record<string, unknown>; close: () => Promise<void> }> {
  let requestBody: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        response.write(`data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requestBody() { return requestBody; }, close };
  servers.push(handle);
  return handle;
}

async function startFlakyJsonServer(responseBody: unknown): Promise<{ baseUrl: string; requestBody: Record<string, unknown>; attempts: number; close: () => Promise<void> }> {
  let requestBody: Record<string, unknown> = {};
  let attempts = 0;
  const server = createServer(async (request, response) => {
    attempts += 1;
    if (attempts === 1) {
      request.socket.destroy(new Error("simulated connection reset"));
      return;
    }
    requestBody = await readJsonBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requestBody() { return requestBody; }, get attempts() { return attempts; }, close };
  servers.push(handle);
  return handle;
}

async function startFlakySseServer(events: Array<unknown | "[DONE]">): Promise<{ baseUrl: string; requestBody: Record<string, unknown>; attempts: number; close: () => Promise<void> }> {
  let requestBody: Record<string, unknown> = {};
  let attempts = 0;
  const server = createServer(async (request, response) => {
    attempts += 1;
    if (attempts === 1) {
      request.socket.destroy(new Error("simulated connection reset"));
      return;
    }
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
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requestBody() { return requestBody; }, get attempts() { return attempts; }, close };
  servers.push(handle);
  return handle;
}

async function startNetworkFailureServer(): Promise<{ baseUrl: string; attempts: number; close: () => Promise<void> }> {
  let attempts = 0;
  const server = createServer((request) => {
    attempts += 1;
    request.socket.destroy(new Error("simulated connection reset"));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get attempts() { return attempts; }, close };
  servers.push(handle);
  return handle;
}

async function startStatusServer(status: number, responseText: string): Promise<{ baseUrl: string; attempts: number; close: () => Promise<void> }> {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    request.resume();
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(responseText);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get attempts() { return attempts; }, close };
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

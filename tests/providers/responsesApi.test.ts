import { createServer, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResponsesApiProvider } from "../../src/providers/responsesApi.js";
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
const promptedTool: Tool = {
  name: "PromptedTool",
  description: "Short provider description",
  prompt: "Long model-facing tool prompt that belongs only in runtime attachments.",
  input_schema: { type: "object", properties: {} },
  async execute() {
    return { output: "" };
  }
};
const context = {
  runId: "run-1",
  nodeId: "dev",
  attempt: 2,
  sessionId: "run-1",
  threadId: "run-1:dev",
  turnId: "run-1:dev:2",
  promptCacheKey: "a".repeat(64)
};

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe("ResponsesApiProvider", () => {
  it("sends Responses API request bodies and context headers", async () => {
    const server = await startJsonServer({ output_text: "{\"direction\":\"forward\"}" });
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key", jsonSchemaOutput: true, promptCache: true, parallelToolCalls: true });

    const result = await provider.generate({
      model: "gpt-test",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "hello" }
      ],
      tools: [tool],
      effort: "custom-level",
      response_schema: responseSchema,
      context
    });

    assert.equal(result.content, "{\"direction\":\"forward\"}");
    assert.equal(server.requestPath, "/v1/responses");
    assert.equal(server.requestHeaders.authorization, "Bearer test-key");
    assert.equal(server.requestHeaders["session-id"], "run-1");
    assert.equal(server.requestHeaders["thread-id"], "run-1:dev");
    assert.equal(server.requestHeaders["x-client-request-id"], "run-1:dev:2");
    assert.equal(server.requestBody.instructions, "System prompt");
    assert.deepEqual(server.requestBody.input, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }
    ]);
    assert.deepEqual(server.requestBody.tools, [{ type: "function", name: "Bash", description: "Run a command", parameters: tool.input_schema }]);
    assert.equal(server.requestBody.tool_choice, "auto");
    assert.equal(server.requestBody.parallel_tool_calls, true);
    assert.deepEqual(server.requestBody.reasoning, { effort: "custom-level" });
    assert.equal(server.requestBody.prompt_cache_key, "a".repeat(64));
    assert.deepEqual(server.requestBody.client_metadata, {
      session_id: "run-1",
      thread_id: "run-1:dev",
      node_id: "dev",
      attempt: "2",
      turn_id: "run-1:dev:2"
    });
    assert.deepEqual(server.requestBody.text, {
      format: { type: "json_schema", name: "node_result", strict: true, schema: responseSchema }
    });
  });

  it("keeps long tool prompts out of Responses API tool schemas", async () => {
    const server = await startJsonServer({ output_text: "{\"direction\":\"forward\"}" });
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [promptedTool] });

    assert.deepEqual(server.requestBody.tools, [{
      type: "function",
      name: "PromptedTool",
      description: "Short provider description",
      parameters: promptedTool.input_schema
    }]);
    assert.doesNotMatch(JSON.stringify(server.requestBody), /Long model-facing tool prompt/);
  });

  it("maps reasoning summary output into normalized thinking text", async () => {
    const server = await startJsonServer({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Checked the plan." }] },
        { type: "message", content: [{ type: "output_text", text: "{\"direction\":\"forward\"}" }] }
      ]
    });
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    const result = await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.equal(result.thinking, "Checked the plan.");
    assert.equal(result.content, "{\"direction\":\"forward\"}");
  });

  it("maps usage and status into normalized response metadata", async () => {
    const server = await startJsonServer({
      output_text: "ok",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
    });
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    const result = await provider.generate({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] });

    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    assert.equal(result.stopReason, "stop");
  });

  it("keeps long trace ids out of prompt_cache_key", async () => {
    const longThreadId = "2026-06-25T10-53-35-371Z-859a43fb-6df8-4959-b37a-97fee9ac57eb:developer";
    const promptCacheKey = "b".repeat(64);
    const server = await startJsonServer({ output_text: "ok" });
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key", promptCache: true });

    await provider.generate({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      context: {
        runId: "2026-06-25T10-53-35-371Z-859a43fb-6df8-4959-b37a-97fee9ac57eb",
        nodeId: "developer",
        attempt: 1,
        sessionId: "2026-06-25T10-53-35-371Z-859a43fb-6df8-4959-b37a-97fee9ac57eb",
        threadId: longThreadId,
        turnId: `${longThreadId}:1`,
        promptCacheKey
      }
    });

    assert.equal(server.requestBody.prompt_cache_key, promptCacheKey);
    assert.equal(String(server.requestBody.prompt_cache_key).length, 64);
    assert.equal(server.requestHeaders["thread-id"], longThreadId);
    assert.deepEqual((server.requestBody.client_metadata as Record<string, string>).thread_id, longThreadId);
  });

  it("maps images, tool calls, and tool outputs into Responses input", async () => {
    const server = await startJsonServer({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] });
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key" });

    await provider.generate({
      model: "gpt-test",
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", media_type: "image/png", data: "abc" }] },
        { role: "assistant", content: "", tool_calls: [{ id: "call-1", name: "Bash", input: { command: "pwd" } }] },
        { role: "tool", tool_call_id: "call-1", content: JSON.stringify({ output: "D:/work" }) }
      ],
      tools: []
    });

    assert.deepEqual(server.requestBody.input, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "data:image/png;base64,abc" }] },
      { type: "function_call", call_id: "call-1", name: "Bash", arguments: JSON.stringify({ command: "pwd" }) },
      { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ output: "D:/work" }) }
    ]);
  });

  it("streams CRLF-delimited text deltas and completed function calls", async () => {
    const server = await startSseServer([
      { type: "response.output_text.delta", delta: "{\"direction\":" },
      { type: "response.output_text.delta", delta: "\"forward\"}" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "Bash", arguments: "{\"command\":\"npm test\"}" } },
      "[DONE]"
    ], "\r\n");
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });
    const deltas: string[] = [];

    const result = await provider.stream?.(
      { model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] },
      (event) => deltas.push(event.text)
    );

    assert.deepEqual(deltas, ["{\"direction\":", "\"forward\"}"]);
    assert.equal(result?.content, "{\"direction\":\"forward\"}");
    assert.deepEqual(result?.tool_calls, [{ id: "call-1", name: "Bash", input: { command: "npm test" } }]);
    assert.equal(server.requestBody.stream, true);
  });

  it("uses response.completed as the streaming fallback for completed tool calls", async () => {
    const server = await startSseServer([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [
            { type: "function_call", call_id: "call-exit", name: "ExitPlanMode", arguments: "{}" }
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
        }
      },
      "[DONE]"
    ]);
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });

    const result = await provider.stream?.(
      { model: "gpt-test", messages: [{ role: "user", content: "approve" }], tools: [] },
      () => undefined
    );

    assert.deepEqual(result?.tool_calls, [{ id: "call-exit", name: "ExitPlanMode", input: {} }]);
    assert.deepEqual(result?.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    assert.equal(result?.stopReason, "tool_call");
  });

  it("streams message text from output_item.done when no delta was emitted", async () => {
    const server = await startSseServer([
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
      "[DONE]"
    ]);
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });
    const deltas: string[] = [];

    const result = await provider.stream?.(
      { model: "gpt-test", messages: [{ role: "user", content: "hello" }], tools: [] },
      (event) => {
        if (event.type === "content_delta") deltas.push(event.text);
      }
    );

    assert.deepEqual(deltas, ["done"]);
    assert.equal(result?.content, "done");
  });

  it("streams reasoning summary deltas as normalized thinking events", async () => {
    const server = await startSseServer([
      { type: "response.reasoning_summary_text.delta", delta: "Checked " },
      { type: "response.reasoning_summary_text.delta", delta: "constraints." },
      { type: "response.output_text.delta", delta: "{\"direction\":\"forward\"}" },
      "[DONE]"
    ]);
    const provider = new ResponsesApiProvider({ baseUrl: server.baseUrl, apiKey: "test-key", streaming: true });
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
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requestPath() { return requestPath; }, get requestBody() { return requestBody; }, get requestHeaders() { return requestHeaders; }, close };
  servers.push(handle);
  return handle;
}

async function startSseServer(events: Array<unknown | "[DONE]">, lineEnding: "\n" | "\r\n" = "\n"): Promise<{ baseUrl: string; requestBody: Record<string, unknown>; close: () => Promise<void> }> {
  let requestBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    requestBody = await readJsonBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
      response.write(`data: ${event === "[DONE]" ? event : JSON.stringify(event)}${lineEnding}${lineEnding}`);
    }
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const handle = { baseUrl: `http://127.0.0.1:${address.port}/v1`, get requestBody() { return requestBody; }, close };
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

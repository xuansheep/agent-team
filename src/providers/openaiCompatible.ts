import { fetch } from "undici";
import { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent, ModelToolCall } from "./types.js";

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  streaming?: boolean;
  jsonSchemaOutput?: boolean;
  userAgent?: string;
};

type OpenAiToolCall = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
};

type OpenAiToolCallDelta = {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAiToolCallDelta[];
    };
  }>;
};

type StreamingToolCall = {
  id?: string;
  name: string;
  arguments: string;
};

type ProviderNetworkError = Error & { detail?: string };

export const defaultProviderUserAgent = "claude-code/2.1.186";

const providerNetworkAttempts = 3;

export function toOpenAiMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => {
    if (Array.isArray(message.content)) {
      return {
        role: message.role,
        content: message.content.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: `data:${part.media_type};base64,${part.data}` } })
      };
    }
    return {
      role: message.role,
      content: message.content,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls?.length ? { tool_calls: toOpenAiToolCalls(message.tool_calls) } : {})
    };
  });
}

function toOpenAiToolCalls(toolCalls: ModelToolCall[]): unknown[] {
  return toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}) ?? "{}"
    }
  }));
}

export class OpenAiCompatibleProvider implements ModelProvider {
  stream?: (request: ModelRequest, onEvent: (event: ModelStreamEvent) => void) => Promise<ModelResponse>;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    if (options.streaming) this.stream = this.streamImpl.bind(this);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    const response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toRequestBody(request, this.options))
    });

    if (!response.ok) {
      throw new Error(`Provider request failed ${response.status}: ${await response.text()}`);
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] } }>;
    };
    const message = body.choices?.[0]?.message ?? {};
    return {
      content: message.content ?? undefined,
      tool_calls: message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || "{}")
      }))
    };
  }

  private async streamImpl(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    const response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...toRequestBody(request, this.options), stream: true })
    });

    if (!response.ok) {
      throw new Error(`Provider request failed ${response.status}: ${await response.text()}`);
    }
    if (!response.body) throw new Error("Provider stream response had no body");

    const content: string[] = [];
    const toolCalls = new Map<number, StreamingToolCall>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        done = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        if (consumeSseBlock(block, content, toolCalls, onEvent)) return toStreamResponse(content, toolCalls);
        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    if (buffer.trim()) consumeSseBlock(buffer, content, toolCalls, onEvent);
    return toStreamResponse(content, toolCalls);
  }

  private endpoint(): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
      "user-agent": this.options.userAgent ?? defaultProviderUserAgent
    };
  }
}

async function fetchProvider(endpoint: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= providerNetworkAttempts; attempt += 1) {
    try {
      return await fetch(endpoint, init);
    } catch (error) {
      lastError = error;
      if (attempt === providerNetworkAttempts) break;
      await delay(attempt * 25);
    }
  }

  const message = errorMessage(lastError);
  const error = new Error(`Provider network request failed after ${providerNetworkAttempts} attempts: ${message}`, { cause: lastError }) as ProviderNetworkError;
  error.detail = providerNetworkDetail(endpoint, providerNetworkAttempts, lastError);
  throw error;
}

function providerNetworkDetail(endpoint: string, attempts: number, error: unknown): string {
  const cause = nestedCause(error) ?? error;
  return [
    `endpoint: ${endpoint}`,
    `attempts: ${attempts}`,
    ...errorDetailLines("error", error),
    ...errorDetailLines("cause", cause)
  ].join("\n");
}

function errorDetailLines(prefix: string, value: unknown): string[] {
  if (value instanceof Error) {
    const code = errorCode(value);
    return [
      `${prefix}.name: ${value.name}`,
      `${prefix}.message: ${value.message}`,
      ...(code ? [`${prefix}.code: ${code}`] : [])
    ];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["name", "message", "code"]
      .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")
      .map((key) => `${prefix}.${key}: ${String(record[key])}`);
  }
  return [`${prefix}.message: ${String(value)}`];
}

function nestedCause(error: unknown): unknown {
  if (error instanceof Error && "cause" in error) return (error as { cause?: unknown }).cause;
  return undefined;
}

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRequestBody(request: ModelRequest, options: OpenAiCompatibleOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request.messages),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }))
  };
  if (options.jsonSchemaOutput && request.response_schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "node_result", strict: true, schema: request.response_schema }
    };
  }
  return body;
}

function consumeSseBlock(
  block: string,
  content: string[],
  toolCalls: Map<number, StreamingToolCall>,
  onEvent: (event: ModelStreamEvent) => void
): boolean {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  if (data === "[DONE]") return true;

  const chunk = JSON.parse(data) as OpenAiStreamChunk;
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) {
      content.push(delta.content);
      onEvent({ type: "content_delta", text: delta.content });
    }
    for (const callDelta of delta.tool_calls ?? []) {
      const current = toolCalls.get(callDelta.index) ?? { name: "", arguments: "" };
      if (callDelta.id) current.id = callDelta.id;
      if (callDelta.function?.name) current.name += callDelta.function.name;
      if (callDelta.function?.arguments) current.arguments += callDelta.function.arguments;
      toolCalls.set(callDelta.index, current);
    }
  }
  return false;
}

function toStreamResponse(content: string[], streamingToolCalls: Map<number, StreamingToolCall>): ModelResponse {
  const tool_calls: ModelToolCall[] = [...streamingToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      id: call.id ?? `call-${index}`,
      name: call.name,
      input: JSON.parse(call.arguments || "{}")
    }));

  return {
    content: content.length ? content.join("") : undefined,
    tool_calls: tool_calls.length ? tool_calls : undefined
  };
}

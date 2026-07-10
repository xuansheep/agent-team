import { buildApiKeyHeaders, consumeSseBlocks, defaultProviderUserAgent, fetchProvider, providerHttpError, ApiKeyMode } from "./http.js";
import { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelStopReason, ModelStreamEvent, ModelToolCall } from "./types.js";
import type { ModelUsage } from "../model/usage.js";

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  apiKeyMode?: ApiKeyMode;
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
    finish_reason?: string;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCallDelta[];
    };
  }>;
};

type StreamingToolCall = {
  id?: string;
  name: string;
  arguments: string;
};

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
      signal: request.signal,
      body: JSON.stringify(toRequestBody(request, this.options))
    });

    if (!response.ok) {
      throw providerHttpError(response.status, await response.text());
    }

    const body = await response.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string; tool_calls?: OpenAiToolCall[] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = body.choices?.[0] ?? {};
    const message = choice.message ?? {};
    return {
      content: message.content ?? undefined,
      thinking: message.reasoning_content ?? undefined,
      tool_calls: message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || "{}")
      })),
      usage: openAiUsage(body.usage),
      stopReason: openAiStopReason(choice.finish_reason)
    };
  }

  private async streamImpl(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    const response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers({ accept: "text/event-stream" }),
      signal: request.signal,
      body: JSON.stringify({ ...toRequestBody(request, this.options), stream: true })
    });

    if (!response.ok) {
      throw providerHttpError(response.status, await response.text());
    }
    if (!response.body) throw new Error("Provider stream response had no body");

    const content: string[] = [];
    const thinking: string[] = [];
    const toolCalls = new Map<number, StreamingToolCall>();

    await consumeSseBlocks(response.body, (data) => {
      const chunk = JSON.parse(data) as OpenAiStreamChunk;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.content) {
          content.push(delta.content);
          onEvent({ type: "content_delta", text: delta.content });
        }
        if (delta.reasoning_content) {
          thinking.push(delta.reasoning_content);
          onEvent({ type: "thinking_delta", text: delta.reasoning_content });
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
    });

    return toStreamResponse(content, thinking, toolCalls);
  }

  private endpoint(): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...buildApiKeyHeaders(this.options.apiKey, this.options.apiKeyMode ?? "bearer"),
      ...extra,
      "content-type": "application/json",
      "user-agent": this.options.userAgent ?? defaultProviderUserAgent
    };
  }
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
  if (typeof request.effort === "string") body.reasoning_effort = request.effort === "max" ? "high" : request.effort;
  if (options.jsonSchemaOutput && request.response_schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "node_result", strict: true, schema: request.response_schema }
    };
  }
  return body;
}

function openAiUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
}

function openAiStopReason(reason: string | undefined): ModelStopReason | undefined {
  if (!reason) return undefined;
  if (reason === "stop") return "stop";
  if (reason === "tool_calls" || reason === "function_call") return "tool_call";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "content_filter";
  return "unknown";
}

function toStreamResponse(content: string[], thinking: string[], streamingToolCalls: Map<number, StreamingToolCall>): ModelResponse {
  const tool_calls: ModelToolCall[] = [...streamingToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      id: call.id ?? `call-${index}`,
      name: call.name,
      input: JSON.parse(call.arguments || "{}")
    }));

  return {
    content: content.length ? content.join("") : undefined,
    thinking: thinking.length ? thinking.join("") : undefined,
    tool_calls: tool_calls.length ? tool_calls : undefined
  };
}

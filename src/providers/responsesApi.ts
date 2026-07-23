import { buildApiKeyHeaders, consumeSseBlocks, defaultProviderUserAgent, fetchProvider, providerHttpError, providerStreamApiError, providerStreamError, withProviderRetry, ApiKeyMode, ProviderRetryConfig } from "./http.js";
import { ModelContentPart, ModelMessage, ModelProvider, ModelProviderError, ModelRequest, ModelResponse, ModelStopReason, ModelStreamEvent, ModelToolCall } from "./types.js";
import type { ModelUsage } from "../model/usage.js";

export type ResponsesApiOptions = {
  baseUrl: string;
  apiKey: string;
  apiKeyMode?: ApiKeyMode;
  streaming?: boolean;
  jsonSchemaOutput?: boolean;
  userAgent?: string;
  promptCache?: boolean;
  parallelToolCalls?: boolean;
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high";
    summary?: string;
  };
  retry?: ProviderRetryConfig;
};

type ResponsesOutputItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  summary?: Array<{ type?: string; text?: string }>;
};

type ResponsesBody = {
  output_text?: string;
  output?: ResponsesOutputItem[];
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number; total_tokens?: number };
};

type ResponsesStreamChunk = {
  type?: string;
  delta?: string;
  item?: ResponsesOutputItem;
  response?: ResponsesBody;
  error?: { message?: string; type?: string; code?: string; status?: number };
};

export class ResponsesApiProvider implements ModelProvider {
  stream?: (request: ModelRequest, onEvent: (event: ModelStreamEvent) => void) => Promise<ModelResponse>;

  constructor(private readonly options: ResponsesApiOptions) {
    if (options.streaming) this.stream = this.streamImpl.bind(this);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    return withProviderRetry({
      request,
      endpoint,
      streaming: false,
      retry: this.options.retry,
      operation: async (attempt) => {
        const response = await fetchProvider(endpoint, {
          method: "POST",
          headers: this.headers(request),
          signal: attempt.signal,
          body: JSON.stringify(toResponsesRequestBody(request, this.options))
        });
        if (!response.ok) throw providerHttpError(response.status, await response.text(), response.headers);
        return fromResponsesBody(await response.json() as ResponsesBody);
      }
    });
  }

  private async streamImpl(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    return withProviderRetry({
      request,
      endpoint,
      streaming: true,
      retry: this.options.retry,
      onStreamEvent: onEvent,
      operation: async (attempt) => {
        const response = await fetchProvider(endpoint, {
          method: "POST",
          headers: this.headers(request, { accept: "text/event-stream" }),
          signal: attempt.signal,
          body: JSON.stringify({ ...toResponsesRequestBody(request, this.options), stream: true })
        });
        if (!response.ok) throw providerHttpError(response.status, await response.text(), response.headers);
        if (!response.body) throw new ModelProviderError("Provider stream response had no body", { errorKind: "server", phase: "request", retryable: true });
        attempt.markStreamStarted();

        const content: string[] = [];
        const thinking: string[] = [];
        const toolCalls: ModelToolCall[] = [];
        let completedBody: ResponsesBody | undefined;
        let completed = false;

        const stopped = await consumeSseBlocks(response.body, (data) => {
          const chunk = JSON.parse(data) as ResponsesStreamChunk;
          if (chunk.error || chunk.type === "error" || chunk.type === "response.failed") {
            throw responsesStreamError(chunk);
          }
          if (chunk.type === "response.output_text.delta" && chunk.delta) {
            content.push(chunk.delta);
            attempt.emit({ type: "content_delta", text: chunk.delta });
          }
          if (chunk.type?.includes("reasoning") && chunk.type.includes("delta") && chunk.delta) {
            thinking.push(chunk.delta);
            attempt.emit({ type: "thinking_delta", text: chunk.delta });
          }
          if (chunk.type === "response.output_item.done" && chunk.item?.type === "function_call") toolCalls.push(toModelToolCall(chunk.item));
          if (chunk.type === "response.output_item.done" && chunk.item?.type === "message" && content.length === 0) {
            const text = textFromOutputItem(chunk.item);
            if (text) {
              content.push(text);
              attempt.emit({ type: "content_delta", text });
            }
          }
          if ((chunk.type === "response.completed" || chunk.type === "response.incomplete") && chunk.response) {
            completed = true;
            completedBody = chunk.response;
          }
          return false;
        }, { signal: attempt.signal, idleTimeoutMs: attempt.streamIdleTimeoutMs });
        if (!stopped && !completed) throw providerStreamError("Provider stream ended before a completion marker");
        const completedResponse = completedBody ? fromResponsesBody(completedBody) : undefined;
        const mergedToolCalls = mergeToolCalls(toolCalls, completedResponse?.tool_calls);
        return {
          content: content.length ? content.join("") : completedResponse?.content,
          thinking: thinking.length ? thinking.join("") : completedResponse?.thinking,
          tool_calls: mergedToolCalls.length ? mergedToolCalls : undefined,
          usage: completedResponse?.usage,
          stopReason: completedResponse?.stopReason
        };
      }
    });
  }

  private endpoint(): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/responses`;
  }

  private headers(request: ModelRequest, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...buildApiKeyHeaders(this.options.apiKey, this.options.apiKeyMode ?? "bearer"),
      ...extra,
      ...(request.context ? {
        "session-id": request.context.sessionId,
        "thread-id": request.context.threadId,
        "x-client-request-id": request.context.turnId
      } : {}),
      "content-type": "application/json",
      "user-agent": this.options.userAgent ?? defaultProviderUserAgent
    };
  }
}

function responsesStreamError(chunk: ResponsesStreamChunk): ModelProviderError {
  const error = chunk.error;
  const detail = JSON.stringify(chunk);
  return providerStreamApiError(error?.message ?? `Provider returned ${chunk.type ?? "a stream error"}`, {
    status: error?.status,
    marker: `${error?.type ?? ""} ${error?.code ?? ""}`,
    detail
  });
}

function toResponsesRequestBody(request: ModelRequest, options: ResponsesApiOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_output_tokens: request.maxOutputTokens,
    input: toResponsesInput(request.messages),
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    })),
    tool_choice: request.tools.length ? "auto" : undefined,
    parallel_tool_calls: options.parallelToolCalls ?? true
  };

  const instructions = systemInstructions(request.messages);
  if (instructions) body.instructions = instructions;
  if (options.promptCache && request.context?.promptCacheKey) body.prompt_cache_key = request.context.promptCacheKey;
  if (request.context) {
    body.client_metadata = {
      session_id: request.context.sessionId,
      thread_id: request.context.threadId,
      node_id: request.context.nodeId,
      attempt: String(request.context.attempt),
      turn_id: request.context.turnId
    };
  }
  const requestedEffort = typeof request.effort === "string" ? request.effort : undefined;
  if (options.reasoning || requestedEffort) {
    body.reasoning = { ...(options.reasoning ?? {}), ...(requestedEffort ? { effort: requestedEffort } : {}) };
  }
  if (options.jsonSchemaOutput && request.response_schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "node_result",
        strict: true,
        schema: request.response_schema
      }
    };
  }

  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function systemInstructions(messages: ModelMessage[]): string | undefined {
  const parts = messages
    .filter((message) => message.role === "system")
    .map((message) => contentAsText(message.content))
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

function toResponsesInput(messages: ModelMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: contentAsText(message.content)
      });
      continue;
    }

    const content = toResponsesMessageContent(message.role, message.content);
    if (content.length) {
      input.push({ type: "message", role: message.role, content });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input ?? {})
      });
    }
  }
  return input;
}

function toResponsesMessageContent(role: "user" | "assistant", content: string | ModelContentPart[]): unknown[] {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === "text") return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
      if (part.type === "tool_reference") return { type: role === "assistant" ? "output_text" : "input_text", text: `Deferred tool loaded: ${part.tool_name}` };
      return { type: "input_image", image_url: `data:${part.media_type};base64,${part.data}` };
    });
  }
  if (!content) return [];
  return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
}

function fromResponsesBody(body: ResponsesBody): ModelResponse {
  const toolCalls: ModelToolCall[] = [];
  const outputText: string[] = [];
  const thinking: string[] = [];

  if (body.output_text) outputText.push(body.output_text);
  for (const item of body.output ?? []) {
    if (item.type === "function_call") toolCalls.push(toModelToolCall(item));
    if (item.type === "reasoning") {
      for (const part of item.summary ?? item.content ?? []) {
        if (part.text) thinking.push(part.text);
      }
    }
    if (!body.output_text && item.type === "message") {
      for (const part of item.content ?? []) {
        if ((part.type === "output_text" || part.type === "text") && part.text) outputText.push(part.text);
      }
    }
  }

  return {
    content: outputText.length ? outputText.join("") : undefined,
    thinking: thinking.length ? thinking.join("") : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    usage: responsesUsage(body.usage),
    stopReason: responsesStopReason(body, toolCalls)
  };
}

function textFromOutputItem(item: ResponsesOutputItem): string | undefined {
  const parts = (item.content ?? []).flatMap((part) =>
    (part.type === "output_text" || part.type === "text") && part.text ? [part.text] : []
  );
  return parts.length ? parts.join("") : undefined;
}

function mergeToolCalls(first: ModelToolCall[], second: ModelToolCall[] | undefined): ModelToolCall[] {
  if (!second?.length) return first;
  const byId = new Map<string, ModelToolCall>();
  for (const call of [...first, ...second]) byId.set(call.id, call);
  return [...byId.values()];
}

function responsesUsage(usage: ResponsesBody["usage"]): ModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: usage.input_tokens_details.cached_tokens } : {}),
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens
  };
}

function responsesStopReason(body: ResponsesBody, toolCalls: ModelToolCall[]): ModelStopReason | undefined {
  if (toolCalls.length) return "tool_call";
  if (body.status === "completed") return "stop";
  if (body.status === "incomplete") return body.incomplete_details?.reason === "max_output_tokens" ? "length" : "unknown";
  return undefined;
}

function toModelToolCall(item: ResponsesOutputItem): ModelToolCall {
  return {
    id: item.call_id ?? item.id ?? "call-0",
    name: item.name ?? "",
    input: JSON.parse(item.arguments || "{}")
  };
}

function contentAsText(content: string | ModelContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

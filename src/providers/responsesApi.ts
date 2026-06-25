import { buildApiKeyHeaders, consumeSseBlocks, defaultProviderUserAgent, fetchProvider, ApiKeyMode } from "./http.js";
import { ModelContentPart, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent, ModelToolCall } from "./types.js";

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
};

type ResponsesOutputItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type ResponsesBody = {
  output_text?: string;
  output?: ResponsesOutputItem[];
};

type ResponsesStreamChunk = {
  type?: string;
  delta?: string;
  item?: ResponsesOutputItem;
};

export class ResponsesApiProvider implements ModelProvider {
  stream?: (request: ModelRequest, onEvent: (event: ModelStreamEvent) => void) => Promise<ModelResponse>;

  constructor(private readonly options: ResponsesApiOptions) {
    if (options.streaming) this.stream = this.streamImpl.bind(this);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    const response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers(request),
      body: JSON.stringify(toResponsesRequestBody(request, this.options))
    });

    if (!response.ok) {
      throw new Error(`Provider request failed ${response.status}: ${await response.text()}`);
    }

    return fromResponsesBody(await response.json() as ResponsesBody);
  }

  private async streamImpl(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    const response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers(request, { accept: "text/event-stream" }),
      body: JSON.stringify({ ...toResponsesRequestBody(request, this.options), stream: true })
    });

    if (!response.ok) {
      throw new Error(`Provider request failed ${response.status}: ${await response.text()}`);
    }
    if (!response.body) throw new Error("Provider stream response had no body");

    const content: string[] = [];
    const toolCalls: ModelToolCall[] = [];

    await consumeSseBlocks(response.body, (data) => {
      const chunk = JSON.parse(data) as ResponsesStreamChunk;
      if (chunk.type === "response.output_text.delta" && chunk.delta) {
        content.push(chunk.delta);
        onEvent({ type: "content_delta", text: chunk.delta });
      }
      if (chunk.type === "response.output_item.done" && chunk.item?.type === "function_call") {
        toolCalls.push(toModelToolCall(chunk.item));
      }
      return false;
    });

    return {
      content: content.length ? content.join("") : undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined
    };
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

function toResponsesRequestBody(request: ModelRequest, options: ResponsesApiOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
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
  if (options.reasoning) body.reasoning = options.reasoning;
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
    return content.map((part) => part.type === "text"
      ? { type: role === "assistant" ? "output_text" : "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.media_type};base64,${part.data}` });
  }
  if (!content) return [];
  return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
}

function fromResponsesBody(body: ResponsesBody): ModelResponse {
  const toolCalls: ModelToolCall[] = [];
  const outputText: string[] = [];

  if (body.output_text) outputText.push(body.output_text);
  for (const item of body.output ?? []) {
    if (item.type === "function_call") toolCalls.push(toModelToolCall(item));
    if (!body.output_text && item.type === "message") {
      for (const part of item.content ?? []) {
        if ((part.type === "output_text" || part.type === "text") && part.text) outputText.push(part.text);
      }
    }
  }

  return {
    content: outputText.length ? outputText.join("") : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined
  };
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

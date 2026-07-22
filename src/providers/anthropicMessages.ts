import { buildApiKeyHeaders, consumeSseBlocks, defaultProviderUserAgent, fetchProvider, providerHttpError, ApiKeyMode } from "./http.js";
import { ModelContentPart, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelStopReason, ModelStreamEvent, ModelToolCall } from "./types.js";
import type { ModelUsage } from "../model/usage.js";

export type AnthropicMessagesOptions = {
  baseUrl: string;
  apiKey: string;
  apiKeyMode?: ApiKeyMode;
  streaming?: boolean;
  jsonSchemaOutput?: boolean;
  userAgent?: string;
  promptCache?: boolean;
  version: string;
  betaHeaders?: string[];
  maxTokens: number;
  thinking?: {
    type: "disabled" | "enabled";
    budget_tokens?: number;
  };
};

const cacheControl = { type: "ephemeral" } as const;

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: unknown;
  tool_use_id?: string;
  tool_name?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  cache_control?: typeof cacheControl;
};

type AnthropicUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

type AnthropicBody = {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
};

type AnthropicStreamChunk = {
  type?: string;
  index?: number;
  message?: AnthropicBody;
  usage?: AnthropicUsage;
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
};

type StreamingBlock =
  | { kind: "text" }
  | { kind: "thinking" }
  | { kind: "tool_use"; id: string; name: string; input?: unknown; inputJson: string; hasInputDelta: boolean };

export class AnthropicMessagesProvider implements ModelProvider {
  stream?: (request: ModelRequest, onEvent: (event: ModelStreamEvent) => void) => Promise<ModelResponse>;
  private nativeDeferredToolsRejected = false;

  constructor(private readonly options: AnthropicMessagesOptions) {
    if (options.streaming) this.stream = this.streamImpl.bind(this);
  }

  deferredToolProtocol(model: string): "portable" | "anthropic-tool-reference" {
    return !this.nativeDeferredToolsRejected && supportsNativeDeferredTools(this.options, model)
      ? "anthropic-tool-reference"
      : "portable";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    let nativeDeferredTools = this.useNativeDeferredTools(request);
    let response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers(request, {}, nativeDeferredTools),
      signal: request.signal,
      body: JSON.stringify(toAnthropicRequestBody(request, this.options, nativeDeferredTools))
    });

    if (!response.ok) {
      const detail = await response.text();
      if (!nativeDeferredTools || !isNativeDeferredToolsRejection(response.status, detail)) {
        throw providerHttpError(response.status, detail);
      }
      this.nativeDeferredToolsRejected = true;
      nativeDeferredTools = false;
      response = await fetchProvider(endpoint, {
        method: "POST",
        headers: this.headers(request),
        signal: request.signal,
        body: JSON.stringify(toAnthropicRequestBody(request, this.options, false))
      });
      if (!response.ok) throw providerHttpError(response.status, await response.text());
    }

    return fromAnthropicBody(await response.json() as AnthropicBody);
  }

  private async streamImpl(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse> {
    const endpoint = this.endpoint();
    let nativeDeferredTools = this.useNativeDeferredTools(request);
    let response = await fetchProvider(endpoint, {
      method: "POST",
      headers: this.headers(request, { accept: "text/event-stream" }, nativeDeferredTools),
      signal: request.signal,
      body: JSON.stringify({ ...toAnthropicRequestBody(request, this.options, nativeDeferredTools), stream: true })
    });

    if (!response.ok) {
      const detail = await response.text();
      if (!nativeDeferredTools || !isNativeDeferredToolsRejection(response.status, detail)) {
        throw providerHttpError(response.status, detail);
      }
      this.nativeDeferredToolsRejected = true;
      nativeDeferredTools = false;
      response = await fetchProvider(endpoint, {
        method: "POST",
        headers: this.headers(request, { accept: "text/event-stream" }),
        signal: request.signal,
        body: JSON.stringify({ ...toAnthropicRequestBody(request, this.options, false), stream: true })
      });
      if (!response.ok) throw providerHttpError(response.status, await response.text());
    }
    if (!response.body) throw new Error("Provider stream response had no body");

    const content: string[] = [];
    const thinking: string[] = [];
    const toolCalls: ModelToolCall[] = [];
    const blocks = new Map<number, StreamingBlock>();
    let usage: AnthropicUsage | undefined;
    let stopReason: string | undefined;

    await consumeSseBlocks(response.body, (data) => {
      const chunk = JSON.parse(data) as AnthropicStreamChunk;
      if (chunk.message?.usage) usage = { ...(usage ?? {}), ...chunk.message.usage };
      if (chunk.usage) usage = { ...(usage ?? {}), ...chunk.usage };
      if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason;
      const index = chunk.index ?? 0;
      if (chunk.type === "content_block_start" && chunk.content_block) {
        if (chunk.content_block.type === "tool_use") {
          blocks.set(index, {
            kind: "tool_use",
            id: chunk.content_block.id ?? `toolu-${index}`,
            name: chunk.content_block.name ?? "",
            input: chunk.content_block.input,
            inputJson: "",
            hasInputDelta: false
          });
        } else if (chunk.content_block.type === "thinking") {
          blocks.set(index, { kind: "thinking" });
          if (chunk.content_block.thinking) {
            thinking.push(chunk.content_block.thinking);
            onEvent({ type: "thinking_delta", text: chunk.content_block.thinking });
          }
        } else {
          blocks.set(index, { kind: "text" });
          if (chunk.content_block.text) {
            content.push(chunk.content_block.text);
            onEvent({ type: "content_delta", text: chunk.content_block.text });
          }
        }
      }
      if (chunk.type === "content_block_delta" && chunk.delta) {
        const block = blocks.get(index);
        if (chunk.delta.type === "text_delta" && chunk.delta.text) {
          content.push(chunk.delta.text);
          onEvent({ type: "content_delta", text: chunk.delta.text });
        }
        if (chunk.delta.type === "thinking_delta" && chunk.delta.thinking) {
          thinking.push(chunk.delta.thinking);
          onEvent({ type: "thinking_delta", text: chunk.delta.thinking });
        }
        if (chunk.delta.type === "input_json_delta" && block?.kind === "tool_use") {
          block.inputJson += chunk.delta.partial_json ?? "";
          block.hasInputDelta = true;
        }
      }
      if (chunk.type === "content_block_stop") {
        const block = blocks.get(index);
        if (block?.kind === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.hasInputDelta ? JSON.parse(block.inputJson || "{}") : block.input ?? {}
          });
        }
      }
      return false;
    });

    return {
      content: content.length ? content.join("") : undefined,
      thinking: thinking.length ? thinking.join("") : undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      usage: anthropicUsage(usage),
      stopReason: anthropicStopReason(stopReason)
    };
  }

  private endpoint(): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/v1/messages`;
  }

  private useNativeDeferredTools(request: ModelRequest): boolean {
    return Boolean(request.deferredTools?.length)
      && this.deferredToolProtocol(request.model) === "anthropic-tool-reference";
  }

  private headers(request: ModelRequest, extra: Record<string, string> = {}, nativeDeferredTools = false): Record<string, string> {
    const betaHeaders = [...new Set([
      ...(this.options.betaHeaders ?? []),
      ...(typeof request.effort === "string" ? ["effort-2025-11-24"] : []),
      ...(nativeDeferredTools ? ["advanced-tool-use-2025-11-20"] : [])
    ].filter(Boolean))].join(",");
    return {
      ...buildApiKeyHeaders(this.options.apiKey, this.options.apiKeyMode ?? "x-api-key"),
      ...extra,
      ...(betaHeaders ? { "anthropic-beta": betaHeaders } : {}),
      "anthropic-version": this.options.version,
      "content-type": "application/json",
      "user-agent": this.options.userAgent ?? defaultProviderUserAgent
    };
  }
}

function toAnthropicRequestBody(request: ModelRequest, options: AnthropicMessagesOptions, nativeDeferredTools = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: Math.min(options.maxTokens, request.maxOutputTokens ?? options.maxTokens),
    system: toAnthropicSystem(request.messages, options.promptCache ?? true),
    messages: toAnthropicMessages(request.messages, options.promptCache ?? true)
  };

  const deferredNames = new Set(nativeDeferredTools ? request.deferredToolNames ?? [] : []);
  const tools = [
    ...request.tools,
    ...(nativeDeferredTools ? request.deferredTools ?? [] : [])
  ].filter((tool, index, all) => all.findIndex((candidate) => candidate.name === tool.name) === index);
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      ...(deferredNames.has(tool.name) ? { defer_loading: true } : {})
    }));
    body.tool_choice = { type: "auto" };
  }
  if (request.context) {
    body.metadata = {
      user_id: JSON.stringify({
        session_id: request.context.sessionId,
        thread_id: request.context.threadId,
        turn_id: request.context.turnId
      })
    };
  }
  if (options.thinking?.type === "enabled") {
    body.thinking = {
      type: "enabled",
      ...(options.thinking.budget_tokens ? { budget_tokens: options.thinking.budget_tokens } : {})
    };
  }
  if (typeof request.effort === "string") body.output_config = { effort: request.effort };
  if (options.jsonSchemaOutput && request.response_schema) {
    body.output_config = {
      ...((body.output_config as Record<string, unknown> | undefined) ?? {}),
      format: {
        type: "json_schema",
        schema: request.response_schema
      }
    };
  }

  if (typeof request.effort === "number" && process.env.USER_TYPE === "ant") {
    body.anthropic_internal = { effort_override: request.effort };
  }
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function toAnthropicSystem(messages: ModelMessage[], promptCache: boolean): unknown[] | undefined {
  const text = messages
    .filter((message) => message.role === "system")
    .map((message) => contentAsText(message.content))
    .filter(Boolean)
    .join("\n\n");
  if (!text) return undefined;
  return [{ type: "text", text, ...(promptCache ? { cache_control: cacheControl } : {}) }];
}

function toAnthropicMessages(messages: ModelMessage[], promptCache: boolean): Array<{ role: "assistant" | "user"; content: AnthropicContentBlock[] }> {
  const anthropicMessages: Array<{ role: "assistant" | "user"; content: AnthropicContentBlock[]; fromTool?: boolean }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" as const : "user" as const;
    const content = toAnthropicContent(message);
    const previous = anthropicMessages.at(-1);
    if (message.role === "tool" && previous?.fromTool) {
      previous.content.push(...content);
      continue;
    }
    if (role === "user" && previous?.role === "user") {
      previous.content.push(...content);
      previous.fromTool = previous.fromTool && message.role === "tool";
      continue;
    }
    anthropicMessages.push({ role, content, fromTool: message.role === "tool" });
  }

  if (promptCache) {
    for (let index = anthropicMessages.length - 1; index >= 0; index -= 1) {
      const content = anthropicMessages[index]?.content;
      if (content.length) {
        const lastBlockIndex = content.length - 1;
        content[lastBlockIndex] = { ...content[lastBlockIndex], cache_control: cacheControl };
        break;
      }
    }
  }

  return anthropicMessages.map(({ role, content }) => ({ role, content }));
}

function toAnthropicContent(message: ModelMessage): AnthropicContentBlock[] {
  if (message.role === "tool") {
    return [{
      type: "tool_result",
      tool_use_id: message.tool_call_id ?? "",
      content: typeof message.content === "string"
        ? message.content
        : message.content.map(toAnthropicContentPart),
      ...(message.is_error === true ? { is_error: true } : {})
    }];
  }

  const blocks = Array.isArray(message.content)
    ? message.content.map(toAnthropicContentPart)
    : message.content ? [{ type: "text", text: message.content }] : [];

  for (const call of message.tool_calls ?? []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
  }
  return blocks;
}

function toAnthropicContentPart(part: ModelContentPart): AnthropicContentBlock {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool_reference") return { type: "tool_reference", tool_name: part.tool_name };
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: part.media_type,
      data: part.data
    }
  };
}

function fromAnthropicBody(body: AnthropicBody): ModelResponse {
  const content: string[] = [];
  const thinking: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const block of body.content ?? []) {
    if (block.type === "text" && block.text) content.push(block.text);
    if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id ?? "toolu-0", name: block.name ?? "", input: block.input ?? {} });
    }
  }

  return {
    content: content.length ? content.join("") : undefined,
    thinking: thinking.length ? thinking.join("") : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    usage: anthropicUsage(body.usage),
    stopReason: anthropicStopReason(body.stop_reason)
  };
}

function anthropicUsage(usage: AnthropicUsage | undefined): ModelUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens === undefined
    && usage.cache_creation_input_tokens === undefined
    && usage.cache_read_input_tokens === undefined
    ? undefined
    : (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    ...(usage.cache_read_input_tokens !== undefined ? { cachedInputTokens: usage.cache_read_input_tokens } : {}),
    outputTokens,
    totalTokens: inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined
  };
}

function anthropicStopReason(reason: string | undefined): ModelStopReason | undefined {
  if (!reason) return undefined;
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "tool_call";
  if (reason === "max_tokens") return "length";
  return "unknown";
}

function contentAsText(content: string | ModelContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "tool_reference") return [`Deferred tool loaded: ${part.tool_name}`];
      return [];
    })
    .join("\n");
}

function supportsNativeDeferredTools(options: AnthropicMessagesOptions, model: string): boolean {
  if (!/^claude-/i.test(model)) return false;
  if (options.betaHeaders?.includes("advanced-tool-use-2025-11-20")) return true;
  try {
    return new URL(options.baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

function isNativeDeferredToolsRejection(status: number, detail: string): boolean {
  return (status === 400 || status === 422)
    && /defer_loading|tool_reference|advanced-tool-use|anthropic-beta/i.test(detail);
}

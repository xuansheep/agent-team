import { Tool } from "../tools/types.js";
import type { ModelUsage } from "../model/usage.js";

export type DeferredToolProtocol = "portable" | "anthropic-tool-reference";

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: "image/png" | "image/jpeg" | "image/webp"; data: string }
  | { type: "tool_reference"; tool_name: string };

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ModelContentPart[];
  tool_call_id?: string;
  is_error?: boolean;
  tool_calls?: ModelToolCall[];
  metadata?: {
    userMessageKind?: "human" | "runtime_context" | "compaction";
    runtimeAttachment?: {
      type: string;
      humanTurnCount: number;
    };
    compactSummary?: boolean;
    durableRuntimeContext?: boolean;
    mcpDiscovery?: {
      discoveredTools?: string[];
      preCompactDiscoveredTools?: string[];
    };
  };
};

export type ModelToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ModelRequestContext = {
  runId: string;
  nodeId: string;
  attempt: number;
  sessionId: string;
  threadId: string;
  turnId: string;
  promptCacheKey: string;
};

export type ModelRequest = {
  model: string;
  effort?: string | number;
  maxOutputTokens?: number;
  messages: ModelMessage[];
  tools: Tool[];
  deferredToolNames?: string[];
  deferredTools?: Tool[];
  response_schema?: unknown;
  context?: ModelRequestContext;
  signal?: AbortSignal;
  onRetry?: (event: ModelRetryEvent) => void | Promise<void>;
};

export type ModelStopReason = "stop" | "tool_call" | "length" | "content_filter" | "error" | "unknown";

export type ModelErrorKind = "network" | "timeout" | "rate_limit" | "auth" | "permission" | "server" | "invalid_request" | "context_limit" | "unknown";

export type ModelRetryPhase = "request" | "stream";

export type ModelRetryEvent = {
  phase: ModelRetryPhase;
  retryAttempt: number;
  maxRetries: number;
  retryInMs: number;
  scheduledAt: string;
  retryAt: string;
  errorKind: ModelErrorKind;
  status?: number;
  message: string;
  detail?: string;
  discardedContentChars: number;
  discardedThinkingChars: number;
};

export type ModelResponse = {
  content?: string;
  thinking?: string;
  tool_calls?: ModelToolCall[];
  usage?: ModelUsage;
  stopReason?: ModelStopReason;
  errorKind?: ModelErrorKind;
};

export class ModelProviderError extends Error {
  readonly errorKind: ModelErrorKind;
  readonly status?: number;
  readonly phase: ModelRetryPhase;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  detail?: string;

  constructor(message: string, input: {
    errorKind: ModelErrorKind;
    status?: number;
    phase?: ModelRetryPhase;
    retryable?: boolean;
    retryAfterMs?: number;
    detail?: string;
    cause?: unknown;
  }) {
    super(message, { cause: input.cause });
    this.name = "ModelProviderError";
    this.errorKind = input.errorKind;
    this.status = input.status;
    this.phase = input.phase ?? "request";
    this.retryable = input.retryable ?? false;
    this.retryAfterMs = input.retryAfterMs;
    this.detail = input.detail;
  }
}

export type ModelStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "thinking_delta"; text: string };

export type ModelProvider = {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse>;
  deferredToolProtocol?(model: string): DeferredToolProtocol;
};

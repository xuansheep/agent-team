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
};

export type ModelStopReason = "stop" | "tool_call" | "length" | "content_filter" | "error" | "unknown";

export type ModelErrorKind = "network" | "rate_limit" | "auth" | "permission" | "server" | "invalid_request" | "context_limit" | "unknown";

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
  detail?: string;

  constructor(message: string, input: { errorKind: ModelErrorKind; status?: number; detail?: string; cause?: unknown }) {
    super(message, { cause: input.cause });
    this.name = "ModelProviderError";
    this.errorKind = input.errorKind;
    this.status = input.status;
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

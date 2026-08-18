import { createHash } from "node:crypto";
import type { ModelRequest } from "../providers/types.js";

export type ModelRequestKind = "sampling" | "compaction" | "runtime" | "bus";
export type ContinuationOutcome = "not_attempted" | "succeeded" | "fallback_rebuild";
export type ProviderCheckpointState = "missing" | "usable" | "empty_delta" | "rejected";
export type ProviderCheckpointRejectionReason =
  | "provider"
  | "model"
  | "system"
  | "tools"
  | "response_schema"
  | "request_properties"
  | "window"
  | "response_id"
  | "message_count"
  | "history_prefix";

export type ModelRequestDiagnostics = {
  request_kind: ModelRequestKind;
  turn_id?: string;
  provider_id?: string;
  phase?: string;
  prompt_cache_key_hash?: string;
  request_signature_hash: string;
  message_history_hash: string;
  static_prefix_hash: string;
  system_prompt_hash: string;
  tool_schema_hash: string;
  tool_count: number;
  message_count: number;
  duration_ms?: number;
  continuation: boolean;
  continuation_attempted: boolean;
  continuation_outcome: ContinuationOutcome;
  continuation_input_message_count?: number;
  checkpoint_state?: ProviderCheckpointState;
  checkpoint_rejection_reason?: ProviderCheckpointRejectionReason;
  provider_response_id_present?: boolean;
  provider_response_id_hash?: string;
  continuation_response_id_hash?: string;
};

export type ModelRequestDiagnosticOptions = {
  providerId?: string;
  phase?: string;
  durationMs?: number;
  continuationAttempted?: boolean;
  continuationOutcome?: ContinuationOutcome;
  continuationInputMessageCount?: number;
  checkpointState?: ProviderCheckpointState;
  checkpointRejectionReason?: ProviderCheckpointRejectionReason;
  providerResponseId?: string | null;
  continuationResponseId?: string;
};

export function modelRequestDiagnostics(
  request: ModelRequest,
  requestKind: ModelRequestKind,
  options: ModelRequestDiagnosticOptions = {}
): ModelRequestDiagnostics {
  const tools = [...request.tools, ...(request.deferredTools ?? [])].map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema
  }));
  const systemMessages = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const promptCacheKey = request.context?.promptCacheKey;
  const continuationAttempted = options.continuationAttempted ?? request.continuation !== undefined;
  const continuationOutcome = options.continuationOutcome
    ?? (continuationAttempted ? "succeeded" : "not_attempted");
  const continuationInputMessageCount = options.continuationInputMessageCount
    ?? request.continuation?.inputMessages.length;
  const continuationResponseId = options.continuationResponseId
    ?? request.continuation?.previousResponseId;
  return {
    request_kind: requestKind,
    ...(request.context?.turnId ? { turn_id: request.context.turnId } : {}),
    ...(options.providerId ? { provider_id: options.providerId } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
    ...(promptCacheKey ? { prompt_cache_key_hash: stableDiagnosticHash(promptCacheKey) } : {}),
    request_signature_hash: stableDiagnosticHash({
      model: request.model,
      effort: request.effort ?? null,
      maxOutputTokens: request.maxOutputTokens ?? null,
      tools,
      toolChoice: request.toolChoice ?? null,
      parallelToolCalls: request.parallelToolCalls ?? null,
      deferredToolNames: request.deferredToolNames ?? [],
      responseSchema: request.response_schema ?? null,
      promptCacheKey: promptCacheKey ?? null
    }),
    message_history_hash: stableDiagnosticHash(request.messages),
    static_prefix_hash: stableDiagnosticHash({ systemMessages, tools }),
    system_prompt_hash: stableDiagnosticHash(systemMessages),
    tool_schema_hash: stableDiagnosticHash(tools),
    tool_count: tools.length,
    message_count: request.messages.length,
    ...(options.durationMs !== undefined ? { duration_ms: Math.max(0, Math.round(options.durationMs)) } : {}),
    continuation: request.continuation !== undefined,
    continuation_attempted: continuationAttempted,
    continuation_outcome: continuationOutcome,
    ...(continuationInputMessageCount !== undefined
      ? { continuation_input_message_count: continuationInputMessageCount }
      : {}),
    ...(options.checkpointState ? { checkpoint_state: options.checkpointState } : {}),
    ...(options.checkpointRejectionReason
      ? { checkpoint_rejection_reason: options.checkpointRejectionReason }
      : {}),
    ...(options.providerResponseId !== undefined
      ? {
          provider_response_id_present: options.providerResponseId !== null && options.providerResponseId.length > 0,
          ...(options.providerResponseId
            ? { provider_response_id_hash: stableDiagnosticHash(options.providerResponseId) }
            : {})
        }
      : {}),
    ...(continuationResponseId
      ? { continuation_response_id_hash: stableDiagnosticHash(continuationResponseId) }
      : {})
  };
}

export function stableDiagnosticHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return "[" + value.map((item) => item === undefined ? "null" : stableJson(item)).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
      .join(",") + "}";
  }
  return "null";
}

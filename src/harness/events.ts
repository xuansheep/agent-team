import type { ModelUsage } from "../model/usage.js";
import type { ModelRequestDiagnostics } from "../model/requestDiagnostics.js";
import type { ModelStopReason } from "../providers/types.js";

export type HarnessEvent =
  | { type: "run_started"; workflow_id: string; input: unknown }
  | { type: "run_continued"; workflow_id: string; input: unknown }
  | { type: "user_message"; text: string; node_id?: string; attempt?: number }
  | { type: "user_input_injected"; input_id: string; text: string; node_id: string; attempt: number; activation?: number }
  | { type: "user_input_deferred"; input_id: string; text: string; node_id: string; attempt: number; activation?: number }
  | { type: "node_started"; node_id: string; attempt: number; activation?: number }
  | { type: "workspace_snapshot_recorded"; node_id: string; attempt: number; activation: number; phase: "before" | "after"; sha256: string; file_count: number; total_bytes: number; complete: boolean; changed?: boolean; changed_paths?: string[]; truncated?: boolean }
  | { type: "node_waiting_user"; node_id: string; attempt?: number; activation?: number; questions: unknown[] }
  | { type: "complete_summary_available"; node_id: string; attempt: number; activation?: number; document: string }
  | { type: "model_thinking_delta"; node_id: string; attempt: number; activation?: number; text: string }
  | { type: "model_stream_delta"; node_id: string; attempt: number; activation?: number; text: string }
  | { type: "model_retry_scheduled"; node_id: string; attempt: number; activation?: number; operation: "sampling" | "compaction"; phase: "request" | "stream"; retry_attempt: number; max_retries: number; retry_in_ms: number; retry_at: string; error_kind: string; status?: number; error: string; detail?: string; discarded_content_chars: number; discarded_thinking_chars: number }
  | { type: "provider_continuation_fallback"; node_id: string; attempt: number; activation?: number; model: string; continuation_turn_id?: string; rebuild_turn_id?: string; continuation_input_message_count: number; continuation_response_id_hash: string; error_kind: string; status?: number; phase: "request" | "stream"; retryable: boolean; error: string; detail?: string }
  | { type: "model_response_recorded"; node_id: string; attempt: number; activation?: number; model: string; usage?: ModelUsage; stop_reason?: ModelStopReason; diagnostics?: ModelRequestDiagnostics }
  | { type: "model_usage_recorded"; node_id: string; attempt: number; activation?: number; model: string; usage: ModelUsage; stop_reason?: ModelStopReason }
  | { type: "node_context_updated"; node_id: string; attempt: number; activation?: number; model?: string; compaction_hash?: string; context_window?: number; context_tokens: number; context_limit?: number; prefix_input_tokens?: number; window_number?: number; current_window_id?: string; dialogue_message_count: number; dialogue_cursor?: number }
  | { type: "node_context_compaction_started"; node_id: string; attempt: number; activation?: number; trigger: "auto"; phase: "pre_turn" | "mid_turn"; reason: "threshold" | "model_change" | "smaller_context"; implementation: "local"; model: string; context_tokens: number; context_limit: number; window_number: number; current_window_id: string }
  | { type: "node_context_compacted"; node_id: string; attempt: number; activation?: number; trigger: "auto"; phase: "pre_turn" | "mid_turn"; reason: "threshold" | "model_change" | "smaller_context"; implementation: "local"; model: string; context_tokens_before: number; context_tokens_after: number; context_limit: number; dialogue_cursor: number; retained_user_message_count: number; retained_runtime_context_count?: number; truncated_message_count?: number; window_number: number; first_window_id: string; previous_window_id: string; current_window_id: string }
  | { type: "node_context_compaction_failed"; node_id: string; attempt: number; activation?: number; trigger: "auto"; phase: "pre_turn" | "mid_turn"; reason: "threshold" | "model_change" | "smaller_context"; implementation: "local"; model: string; error: string }
  | { type: "mcp_catalog_published"; node_id: string; attempt?: number; activation?: number; revision: number; protocol: "portable" | "anthropic-tool-reference"; deferred_tools: string[]; discovered_tools: string[]; pending_servers: string[]; failed_servers: string[] }
  | { type: "mcp_tools_discovered"; node_id: string; attempt?: number; activation?: number; query: string; tools: string[] }
  | { type: "tool_invoked"; node_id: string; attempt?: number; activation?: number; tool_call_id?: string; tool: string; input: unknown; via?: string }
  | { type: "tool_completed"; node_id: string; attempt?: number; activation?: number; tool_call_id?: string; tool: string; result: unknown; via?: string }
  | { type: "tool_failed"; node_id: string; attempt?: number; activation?: number; tool_call_id?: string; tool: string; error: string; result?: unknown; failure_category?: string; failure_fingerprint?: string; failure_count?: number; retry_blocked?: boolean; via?: string }
  | { type: "managed_process_started"; node_id: string; attempt?: number; activation?: number; process_id: string; pid: number; executable: string; output_path?: string }
  | { type: "managed_process_stopped"; node_id: string; attempt?: number; activation?: number; process_id: string; pid: number; reason: "explicit" | "node_complete" | "node_error" | "interrupted"; exit_code: number | null }
  | { type: "managed_process_cleanup_failed"; node_id: string; attempt?: number; activation?: number; process_id: string; pid: number; reason: "explicit" | "node_complete" | "node_error" | "interrupted"; error: string }
  | { type: "artifact_read"; node_id: string; attempt?: number; artifact_id: string; offset: number; bytes_read: number; total_bytes: number; truncated: boolean; source: "handoff" | "tool" }
  | { type: "skill_activated"; node_id: string; attempt?: number; activation?: number; name: string; mode: "inline" | "fork"; source: string; version?: string; allowed_tools: string[] }
  | { type: "artifact_created"; node_id: string; artifact_id: string; path: string }
  | { type: "node_completed"; node_id: string; attempt?: number; activation?: number; status: "success" | "failure" | "completed" | "suspended" | "retrying"; result: unknown }
  | { type: "transition"; from: string; to: string; reason: "success" | "failure" | "forward" | "backward" | "retry"; activation?: number }
  | { type: "permission_requested"; request_id: string; node_id: string; attempt: number; tool_call_id: string; tool: string; input: unknown; rule?: string; specifier: string; via?: string }
  | { type: "permission_resolved"; request_id: string; node_id: string; attempt: number; tool_call_id: string; decision: "allow_once" | "deny_once" }
  | { type: "node_interrupted"; node_id: string; attempt: number }
  | { type: "bus_node_dispatched"; from_node_id?: string; to_node_id: string; reason?: string }
  | { type: "run_awaiting_bus"; node_id: string; reason: "workflow_boundary" | "team_boundary" | "reassigned" | "finalizing" }
  | { type: "run_interrupted"; reason: "user" }
  | { type: "run_completed"; result: unknown }
  | { type: "run_cancelled"; reason: string }
  | { type: "run_failed"; error: string; detail?: string };

export type StoredEvent = HarnessEvent & {
  ts: string;
  seq: number;
};

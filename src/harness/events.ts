import type { ModelUsage } from "../model/usage.js";
import type { ModelStopReason } from "../providers/types.js";

export type HarnessEvent =
  | { type: "run_started"; workflow_id: string; input: unknown }
  | { type: "user_message"; text: string; node_id?: string; attempt?: number }
  | { type: "node_started"; node_id: string; attempt: number }
  | { type: "node_waiting_user"; node_id: string; questions: unknown[] }
  | { type: "plan_review_requested"; node_id: string; attempt: number; document: string; plan_file_path?: string }
  | { type: "plan_review_resolved"; node_id: string; attempt: number; decision: "continue" | "stay" }
  | { type: "complete_summary_available"; node_id: string; attempt: number; document: string }
  | { type: "model_thinking_delta"; node_id: string; attempt: number; text: string }
  | { type: "model_stream_delta"; node_id: string; attempt: number; text: string }
  | { type: "model_usage_recorded"; node_id: string; attempt: number; model: string; usage: ModelUsage; stop_reason?: ModelStopReason }
  | { type: "tool_invoked"; node_id: string; attempt?: number; tool_call_id?: string; tool: string; input: unknown }
  | { type: "tool_completed"; node_id: string; attempt?: number; tool_call_id?: string; tool: string; result: unknown }
  | { type: "tool_failed"; node_id: string; attempt?: number; tool_call_id?: string; tool: string; error: string }
  | { type: "artifact_created"; node_id: string; artifact_id: string; path: string }
  | { type: "node_completed"; node_id: string; status: "success" | "failure"; result: unknown }
  | { type: "transition"; from: string; to: string; reason: "success" | "failure" }
  | { type: "permission_requested"; request_id: string; node_id: string; attempt: number; tool_call_id: string; tool: string; input: unknown; rule?: string; specifier: string }
  | { type: "permission_resolved"; request_id: string; node_id: string; attempt: number; tool_call_id: string; decision: "allow_once" | "deny_once" }
  | { type: "node_interrupted"; node_id: string; attempt: number }
  | { type: "run_interrupted"; reason: "user" }
  | { type: "run_completed"; result: unknown }
  | { type: "run_failed"; error: string; detail?: string };

export type StoredEvent = HarnessEvent & {
  ts: string;
  seq: number;
};

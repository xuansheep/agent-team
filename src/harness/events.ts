import type { ModelUsage } from "../model/usage.js";
import type { ModelStopReason } from "../providers/types.js";

export type HarnessEvent =
  | { type: "run_started"; workflow_id: string; input: unknown }
  | { type: "run_continued"; workflow_id: string; input: unknown }
  | { type: "user_message"; text: string; node_id?: string; attempt?: number }
  | { type: "node_started"; node_id: string; attempt: number; activation?: number }
  | { type: "node_waiting_user"; node_id: string; attempt?: number; activation?: number; questions: unknown[] }
  | { type: "complete_summary_available"; node_id: string; attempt: number; activation?: number; document: string }
  | { type: "model_thinking_delta"; node_id: string; attempt: number; activation?: number; text: string }
  | { type: "model_stream_delta"; node_id: string; attempt: number; activation?: number; text: string }
  | { type: "model_usage_recorded"; node_id: string; attempt: number; activation?: number; model: string; usage: ModelUsage; stop_reason?: ModelStopReason }
  | { type: "tool_invoked"; node_id: string; attempt?: number; activation?: number; tool_call_id?: string; tool: string; input: unknown }
  | { type: "tool_completed"; node_id: string; attempt?: number; activation?: number; tool_call_id?: string; tool: string; result: unknown }
  | { type: "tool_failed"; node_id: string; attempt?: number; activation?: number; tool_call_id?: string; tool: string; error: string; result?: unknown }
  | { type: "artifact_read"; node_id: string; attempt?: number; artifact_id: string; offset: number; bytes_read: number; total_bytes: number; truncated: boolean; source: "handoff" | "tool" }
  | { type: "skill_activated"; node_id: string; attempt?: number; activation?: number; name: string; mode: "inline" | "fork"; source: string; version?: string; allowed_tools: string[] }
  | { type: "artifact_created"; node_id: string; artifact_id: string; path: string }
  | { type: "node_completed"; node_id: string; attempt?: number; activation?: number; status: "success" | "failure" | "completed" | "suspended" | "retrying"; result: unknown }
  | { type: "transition"; from: string; to: string; reason: "success" | "failure" | "forward" | "backward" | "retry"; activation?: number }
  | { type: "permission_requested"; request_id: string; node_id: string; attempt: number; tool_call_id: string; tool: string; input: unknown; rule?: string; specifier: string }
  | { type: "permission_resolved"; request_id: string; node_id: string; attempt: number; tool_call_id: string; decision: "allow_once" | "deny_once" }
  | { type: "node_interrupted"; node_id: string; attempt: number }
  | { type: "run_interrupted"; reason: "user" }
  | { type: "run_completed"; result: unknown }
  | { type: "run_cancelled"; reason: string }
  | { type: "run_failed"; error: string; detail?: string };

export type StoredEvent = HarnessEvent & {
  ts: string;
  seq: number;
};

import { ModelMessage } from "../providers/types.js";
import type { ExecutionKind } from "../config/schema.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";

export const CONVERSATION_INTERRUPTED_QUESTION_ID = "conversation_interrupted";
export const CONVERSATION_INTERRUPTED_TEXT = "■ Conversation interrupted. Describe how to proceed, or enter retry instructions.";

export type RunStatus = "running" | "waiting_user" | "paused" | "awaiting_bus" | "completed" | "failed" | "cancelled" | "pending";

export type NodeActivationState = {
  activation: number;
  status: "running" | "forwarded" | "returned" | "retrying" | "waiting_user" | "interrupted" | "failed";
  result?: unknown;
};

export type NodeAttemptState = {
  node_id: string;
  attempt: number;
  activation?: number;
  status: "running" | "completed" | "suspended" | "success" | "failure" | "waiting_user";
  activations?: NodeActivationState[];
  result?: unknown;
};

export type ResumeCheckpoint = {
  node_id: string;
  handoff: unknown;
  attempt?: number;
  activation?: number;
  dialogue_cursor?: number;
  dialogue_messages?: ModelMessage[];
};

export type PendingInteraction =
  | { type: "node_user"; node_id: string; questions: unknown[] }
  | { type: "rework_limit"; node_id: string; questions: unknown[]; result: unknown };

export type WorkflowState = {
  version?: 2 | 3 | 4 | 5;
  session_id?: string;
  run_id?: string;
  created_at?: string;
  updated_at?: string;
  revision?: number;
  status: RunStatus;
  workflow_id: string;
  execution_kind?: ExecutionKind;
  config_fingerprint?: string;
  run_permission_mode?: Exclude<PermissionMode, "plan">;
  plan_requested_permission_rules?: string[];
  current_node_id?: string;
  attempts: NodeAttemptState[];
  handoff?: unknown;
  resume_checkpoint?: ResumeCheckpoint;
  node_checkpoints?: Record<string, ResumeCheckpoint>;
  suspended_stack?: string[];
  rework_count?: number;
  rework_limit?: number;
  pending_interaction?: PendingInteraction;
  final_summary?: string;
};

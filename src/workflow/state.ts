import { ModelMessage } from "../providers/types.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";

export type RunStatus = "running" | "pending" | "completed";

export type NodeAttemptState = {
  node_id: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user";
  result?: unknown;
};

export type ResumeCheckpoint = {
  node_id: string;
  handoff: unknown;
  attempt?: number;
  dialogue_messages?: ModelMessage[];
};

export type WorkflowState = {
  status: RunStatus;
  workflow_id: string;
  run_permission_mode?: Exclude<PermissionMode, "plan">;
  plan_requested_permission_rules?: string[];
  current_node_id?: string;
  attempts: NodeAttemptState[];
  handoff?: unknown;
  resume_checkpoint?: ResumeCheckpoint;
};

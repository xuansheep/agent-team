import { ModelMessage } from "../providers/types.js";

export type RunStatus = "running" | "pending" | "completed";

export type NodeAttemptState = {
  node_id: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user";
  result?: unknown;
};

export type PendingReview = {
  type: "plan";
  node_id: string;
  attempt: number;
  document: string;
  plan_file_path?: string;
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
  current_node_id?: string;
  attempts: NodeAttemptState[];
  handoff?: unknown;
  pending_review?: PendingReview;
  resume_checkpoint?: ResumeCheckpoint;
};

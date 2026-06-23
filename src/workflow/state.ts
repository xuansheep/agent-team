export type RunStatus = "running" | "waiting_user" | "waiting_plan_review" | "completed" | "failed" | "interrupted";

export type NodeAttemptState = {
  node_id: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user" | "waiting_plan_review";
  result?: unknown;
};

export type PendingReview = {
  type: "plan";
  node_id: string;
  attempt: number;
  document: string;
};

export type WorkflowState = {
  status: RunStatus;
  workflow_id: string;
  current_node_id?: string;
  attempts: NodeAttemptState[];
  handoff?: unknown;
  pending_review?: PendingReview;
};

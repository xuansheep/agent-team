export type RunStatus = "running" | "waiting_user" | "completed" | "failed" | "interrupted";

export type NodeAttemptState = {
  node_id: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user";
  result?: unknown;
};

export type WorkflowState = {
  status: RunStatus;
  workflow_id: string;
  current_node_id?: string;
  attempts: NodeAttemptState[];
  handoff?: unknown;
};

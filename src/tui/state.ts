import type { TuiLogMessage } from "./logTypes.js";

export type TuiMode =
  | "boot"
  | "select_workflow"
  | "input"
  | "running"
  | "permission"
  | "question"
  | "waiting_plan_review"
  | "plan_revision"
  | "confirm_interrupt"
  | "completed"
  | "failed"
  | "interrupted";

export type TuiNodeState = {
  nodeId: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user" | "waiting_plan_review" | "interrupted";
};

export type TuiWorkflowNodeState = {
  id: string;
  role: string;
};

export type TuiToolState = {
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  result?: unknown;
  error?: string;
  expanded: boolean;
};

export type TuiPermissionRequestState = {
  requestId: string;
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  input: unknown;
  specifier: string;
  rule?: string;
};

export type TuiPlanReviewState = {
  type: "plan";
  nodeId: string;
  attempt: number;
  document: string;
};

export type TuiModelStreamState = {
  nodeId: string;
  attempt: number;
  text: string;
};

export type TuiConversationItem = {
  kind: "user" | "assistant" | "status";
  text: string;
  detailText?: string;
  nodeId?: string;
  attempt?: number;
};

export type TuiState = {
  cwd: string;
  mode: TuiMode;
  workflowId?: string;
  runId?: string;
  currentNodeId?: string;
  nodes: TuiNodeState[];
  tools: TuiToolState[];
  permissionRequests: TuiPermissionRequestState[];
  pendingReview?: TuiPlanReviewState;
  modelStreams: TuiModelStreamState[];
  conversation: TuiConversationItem[];
  logMessages: TuiLogMessage[];
  questions: unknown[];
  timeline: string[];
  error?: string;
};

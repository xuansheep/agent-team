export type TuiMode =
  | "boot"
  | "select_workflow"
  | "input"
  | "running"
  | "permission"
  | "question"
  | "confirm_interrupt"
  | "completed"
  | "failed"
  | "interrupted";

export type TuiNodeState = {
  nodeId: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user" | "interrupted";
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

export type TuiState = {
  cwd: string;
  mode: TuiMode;
  workflowId?: string;
  runId?: string;
  currentNodeId?: string;
  nodes: TuiNodeState[];
  tools: TuiToolState[];
  permissionRequests: TuiPermissionRequestState[];
  questions: unknown[];
  timeline: string[];
  error?: string;
};

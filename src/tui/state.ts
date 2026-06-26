import type { RunSummary } from "../storage/runStore.js";


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


  | "resume_picker"


  | "confirm_new"


  | "confirm_resume"


  | "confirm_interrupt"
  | "paused"


  | "completed"


  | "failed"


  | "interrupted";





export type TuiNodeState = {


  nodeId: string;


  attempt: number;


  status: "running" | "success" | "failure" | "waiting_user" | "interrupted";


};





export type TuiWorkflowNodeState = {


  id: string;


  role: string;


  model?: string;


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
  planFilePath?: string;


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


  detailVisible?: boolean;


  nodeId?: string;


  attempt?: number;


  source?: "model_stream";


  streamEnd?: number;


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


  resumeRuns: RunSummary[];


  pendingResumeRunId?: string;


  modeBeforeConfirmation?: TuiMode;


  error?: string;


};



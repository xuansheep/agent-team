import type { ModelUsageTotals } from "../model/usage.js";
import type { PlanSessionState } from "../plans/planSession.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import type { TuiLogMessage } from "./logTypes.js";

export type TuiRunState = "starting" | "ready" | "working" | "waiting" | "thinking";

export type TuiMode =
  | "boot"
  | "select_workflow"
  | "input"
  | "running"
  | "permission"
  | "permissions"
  | "question"
  | "planning"
  | "waiting_plan_approval"
  | "resume_picker"
  | "confirm_new"
  | "confirm_delete_session"
  | "confirm_resume"
  | "confirm_interrupt"
  | "paused"
  | "completed"
  | "failed"
  | "interrupted";

export type TuiNodeState = {
  nodeId: string;
  attempt: number;
  activation?: number;
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextLimit?: number;
  status: "running" | "completed" | "suspended" | "retrying" | "success" | "failure" | "waiting_user" | "interrupted";
};

export type TuiWorkflowNodeState = {
  id: string;
  role: string;
  model?: string;
  effort?: string;
  contextWindow?: number;
  contextLimit?: number;
};

export type TuiToolState = {
  nodeId: string;
  attempt: number;
  activation?: number;
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
  empty?: boolean;
  requestedPermissions?: Array<{ tool: string; prompt: string }>;
  toolCallId?: string;
  savedMessage?: string;
  contextUsedPercent?: number;
};

export type TuiModelStreamState = {
  nodeId: string;
  attempt: number;
  activation?: number;
  text: string;
};

export type TuiModelRetryState = {
  nodeId?: string;
  attempt?: number;
  activation?: number;
  operation: "sampling" | "compaction";
  phase: "request" | "stream";
  retryAttempt: number;
  maxRetries: number;
  retryInMs: number;
  retryAt: string;
  errorKind: string;
  status?: number;
  error: string;
  detail?: string;
};

export type TuiConversationItem = {
  kind: "user" | "assistant" | "status";
  text: string;
  detailText?: string;
  detailVisible?: boolean;
  nodeId?: string;
  attempt?: number;
  activation?: number;
  source?: "model_stream";
  streamEnd?: number;
};

export type TuiResumeEntry = {
  id: string;
  sessionId: string;
  status?: string;
  workflowRunId?: string;
  updatedAt: string;
  inputPreview: string;
  planMode?: PlanSessionState["mode"];
};

export type TuiDefaultExecutionMode = Extract<PermissionMode, "default" | "fullAccess">;

export type TuiState = {
  cwd: string;
  mode: TuiMode;
  runState: TuiRunState;
  inputPermissionMode: PermissionMode;
  defaultExecutionMode: TuiDefaultExecutionMode;
  sessionUsage: ModelUsageTotals;
  modelRequestCount: number;
  workflowId?: string;
  runId?: string;
  busNodeId?: string;
  currentNodeId?: string;
  suspendedStack: string[];
  nodes: TuiNodeState[];
  tools: TuiToolState[];
  permissionRequests: TuiPermissionRequestState[];
  pendingReview?: TuiPlanReviewState;
  planSession?: PlanSessionState;
  modelStreams: TuiModelStreamState[];
  modelStreamLocations: Record<string, { conversationIndex: number; logIndex: number }>;
  activeModelRetry?: TuiModelRetryState;
  activityNotice?: { text: string; tone: "warning" };
  conversation: TuiConversationItem[];
  logMessages: TuiLogMessage[];
  questions: unknown[];
  resumeRuns: TuiResumeEntry[];
  focusedResumeId?: string;
  pendingDeleteSessionId?: string;
  resumePickerNotice?: string;
  pendingResumeRunId?: string;
  modeBeforeConfirmation?: TuiMode;
  error?: string;
};

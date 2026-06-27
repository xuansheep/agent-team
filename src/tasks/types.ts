import type { ModelMessage, ModelProvider } from "../providers/types.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import type { ToolRegistry } from "../tools/registry.js";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "waiting_plan_approval";

export type TaskRecord = {
  id: string;
  kind: string;
  name?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  input?: unknown;
  result?: unknown;
  output?: string;
  error?: string;
  sessionId?: string;
  parentSessionId?: string;
  planApprovalId?: string;
  events: unknown[];
};

export type TaskStartInput = {
  kind: string;
  name?: string;
  input?: unknown;
  parentSessionId?: string;
};

export type TaskRunContext = {
  cwd: string;
  permissions?: ToolPermissionContext;
  eventSink?: (event: TaskEvent) => void | Promise<void>;
};

export type TaskRunResult =
  | { status: "completed"; result?: unknown; output?: string; sessionId?: string; events?: unknown[] }
  | { status: "failed"; error: string; events?: unknown[] }
  | { status: "waiting_plan_approval"; planApprovalId: string; result?: unknown; output?: string; sessionId?: string; events?: unknown[] };

export type TaskHandler = (task: TaskRecord, context: TaskRunContext) => Promise<TaskRunResult> | TaskRunResult;

export type TaskEvent =
  | { type: "task_created"; task_id: string; kind: string }
  | { type: "task_started"; task_id: string; kind: string }
  | { type: "task_completed"; task_id: string; result?: unknown }
  | { type: "task_failed"; task_id: string; error: string }
  | { type: "task_waiting_plan_approval"; task_id: string; plan_approval_id: string };

export type LocalAgentTaskInput = {
  provider: ModelProvider;
  model: string;
  messages: ModelMessage[];
  cwd: string;
  tools?: ToolRegistry;
  permissions?: Partial<ToolPermissionContext>;
  sessionId?: string;
};

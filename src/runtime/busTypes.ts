import type { ModelMessage } from "../providers/types.js";
import type { WorkflowSession } from "../workflow/session.js";
import type { WorkflowRunDossier } from "../workflow/dossier.js";

export type BusTaskStatus =
  | "idle"
  | "routing"
  | "planning"
  | "running_workflow"
  | "waiting_user"
  | "awaiting_bus"
  | "finalized"
  | "failed";

export type TaskSummary = {
  summary: string;
  outcomes: string[];
  verification: string[];
  residual_risks: string[];
  artifacts: string[];
};

export type DispatchDirective =
  | { type: "answer"; confidence: number; message: string }
  | { type: "clarify"; confidence: number; message: string }
  | { type: "plan"; confidence: number; node_id: string; reason: string }
  | { type: "dispatch"; confidence: number; node_id: string; instruction: string; reason: string }
  | { type: "finalize"; confidence: number; summary: TaskSummary };

export type BusIntent =
  | { type: "user_message"; input: unknown; planMode?: boolean }
  | { type: "workflow_boundary"; dossier: WorkflowRunDossier };

export type BusEvent =
  | { type: "bus_routing_started"; session_id: string; workflow_id: string; routing_id: string; phase: "user" | "plan" | "lifecycle" }
  | { type: "bus_model_thinking_delta"; session_id: string; workflow_id: string; routing_id: string; text: string }
  | { type: "bus_directive_selected"; session_id: string; workflow_id: string; routing_id: string; phase: "user" | "plan" | "lifecycle"; directive: DispatchDirective; thinking?: string }
  | { type: "bus_assistant_message"; session_id: string; workflow_id: string; content: string }
  | { type: "bus_clarification_requested"; session_id: string; workflow_id: string; content: string; reason: "low_confidence" | "dispatcher_failure" | "invalid_directive" | "rework_limit" }
  | { type: "bus_plan_node_selected"; session_id: string; workflow_id: string; node_id: string; reason: string }
  | { type: "bus_workflow_started"; session_id: string; workflow_id: string; run_id: string; node_id: string }
  | { type: "bus_workflow_reassigned"; session_id: string; workflow_id: string; run_id: string; from_node_id?: string; to_node_id: string; reason: string }
  | { type: "bus_workflow_awaiting"; session_id: string; workflow_id: string; run_id: string; node_id?: string }
  | { type: "bus_task_finalized"; session_id: string; workflow_id: string; run_id: string; summary: TaskSummary }
  | { type: "bus_dispatcher_retry_scheduled"; session_id: string; workflow_id: string; routing_id: string; retry_attempt: number; max_retries: number; retry_in_ms: number; error: string; discarded_thinking_chars: number }
  | { type: "bus_failed"; session_id: string; workflow_id: string; error: string };

export type BusDirectiveSelectedEvent = Extract<BusEvent, { type: "bus_directive_selected" }>;

export type BusTaskState = {
  session_id: string;
  workflow_id: string;
  status: BusTaskStatus;
  revision: number;
  selected_node_id?: string;
  active_run_id?: string;
  current_node_id?: string;
  rework_cycles: number;
  last_directive?: DispatchDirective;
  summary?: TaskSummary;
  messages: ModelMessage[];
};

export type SessionBusCheckpoint = Omit<BusTaskState, "messages">;

export type BusTurnResult = {
  state: BusTaskState;
  directive: DispatchDirective;
  workflow?: WorkflowSession;
};

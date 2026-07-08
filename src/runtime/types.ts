import { ModelMessage, ModelProvider, ModelStopReason } from "../providers/types.js";
import type { ModelUsage } from "../model/usage.js";
import type { AuditSink } from "../audit/auditEvent.js";
import type { GlobalPromptMetadata, GlobalPromptSourceMetadata } from "../config/schema.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolPermissionContext } from "../permissions/context.js";
import { PlanRequestedPermission, PlanSessionState } from "../plans/planSession.js";
import type { HookRuntime } from "../hooks/runtime.js";

export type { ToolPermissionContext } from "../permissions/context.js";
export type { PermissionMode } from "../permissions/PermissionMode.js";

export type PlanApprovalRequest = {
  sessionId: string;

  planFilePath: string;
  empty?: boolean;
  requestedPermissions?: PlanRequestedPermission[];
};

export type RuntimeUserInputRequest = {
  sessionId: string;
  runId?: string;
  toolCallId: string;
  questions: unknown[];
};

export type RuntimePermissionRequest = {
  sessionId: string;
  runId?: string;
  tool: string;
  input: unknown;
  reason?: string;
  rule?: string;
};

export type RuntimePermissionDecision = "allow" | "deny";

export type PromptInjectionRecord = {
  type: "global_prompt";
  recordedAt: string;
  available: boolean;
  presentInRequest: boolean;
  injectedThisTurn: boolean;
  sha256?: string;
  chars?: number;
  lines?: number;
  sources?: GlobalPromptSourceMetadata[];
};

export type PlanModeEvent =
  | { type: "plan_mode_entered"; session_id: string; plan_file_path: string }
  | { type: "plan_draft_updated"; session_id: string; plan_file_path: string }
  | { type: "plan_approval_requested"; session_id: string; plan_file_path: string; empty?: boolean; requested_permissions?: PlanRequestedPermission[] }
  | { type: "plan_approval_resolved"; session_id: string; decision: "continue" | "stay" };

export type RuntimeEvent =
  | { type: "runtime_turn_started"; session_id: string; run_id?: string }
  | { type: "runtime_prompt_injection"; session_id: string; run_id?: string; record: PromptInjectionRecord }
  | { type: "runtime_assistant_message"; session_id: string; run_id?: string; content: string }
  | { type: "runtime_model_usage"; session_id: string; run_id?: string; model: string; usage: ModelUsage; stop_reason?: ModelStopReason }
  | { type: "runtime_user_input_requested"; session_id: string; run_id?: string; tool_call_id: string; questions: unknown[] }
  | { type: "runtime_permission_requested"; session_id: string; run_id?: string; tool: string; input: unknown; reason?: string; rule?: string }
  | { type: "runtime_permission_resolved"; session_id: string; run_id?: string; tool: string; decision: RuntimePermissionDecision }
  | { type: "runtime_tool_invoked"; session_id: string; run_id?: string; tool_call_id: string; tool: string; input: unknown }
  | { type: "runtime_tool_completed"; session_id: string; run_id?: string; tool_call_id: string; tool: string; result: unknown }
  | { type: "runtime_tool_failed"; session_id: string; run_id?: string; tool_call_id: string; tool: string; error: string }
  | PlanModeEvent;

export type RuntimeTurnInput = {
  messages: ModelMessage[];
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: ToolPermissionContext;
  cwd: string;
  sessionId: string;
  runId?: string;
  globalPrompt?: string;
  globalPromptMetadata?: GlobalPromptMetadata;
  eventSink?: (event: RuntimeEvent) => void | Promise<void>;
  auditSink?: AuditSink;
  abortSignal?: AbortSignal;
  permissionCallback?: (request: RuntimePermissionRequest) => RuntimePermissionDecision | Promise<RuntimePermissionDecision>;
  planState?: PlanSessionState;
  hookRuntime?: HookRuntime;
};

export type RuntimeTurnResult =
  | { status: "completed"; messages: ModelMessage[]; result?: unknown }
  | { status: "waiting_permission"; messages: ModelMessage[]; request?: RuntimePermissionRequest }
  | { status: "waiting_user_input"; messages: ModelMessage[]; request: RuntimeUserInputRequest }
  | { status: "waiting_plan_approval"; messages: ModelMessage[]; plan: PlanApprovalRequest; planState: PlanSessionState; usage?: ModelUsage }
  | { status: "aborted"; messages: ModelMessage[] }
  | { status: "failed"; error: string; messages: ModelMessage[] };

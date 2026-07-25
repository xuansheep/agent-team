import type { ToolPermissionContext } from "../permissions/context.js";
import type { PlanRequestedPermission, PlanSessionState } from "../plans/planSession.js";
import type { ModelMessage } from "../providers/types.js";
import { projectKernelAppState } from "./appState.js";

export type KernelStatus =
  | "idle_input"
  | "running_query"
  | "planning"
  | "waiting_tool_permission"
  | "waiting_user_input"
  | "waiting_plan_approval"
  | "running_workflow"
  | "interrupted_restoring";

export type PendingInteraction =
  | { type: "tool_permission"; id: string; sessionId: string; runId?: string; tool: string; input: unknown; reason?: string; rule?: string }
  | { type: "ask_user_question"; id: string; sessionId: string; runId?: string; toolCallId: string; questions: unknown[] }
  | { type: "plan_approval"; id: string; sessionId: string; planFilePath: string; planHash?: string; empty?: boolean; requestedPermissions?: PlanRequestedPermission[]; toolCallId?: string }
  | { type: "interrupt_confirmation"; id: string; sessionId: string; message: string };

export type WorkflowBinding = {
  runId: string;
  status: "pending" | "running" | "waiting" | "completed";
  approvalId?: string;
  planHash?: string;
};

export type PlanApprovalResolveMetadata = {
  permissionMode?: Exclude<ToolPermissionContext["mode"], "plan">;
  clearContext?: boolean;
  feedback?: unknown;
};

export type KernelExecutionHandoff = {
  clearContext: boolean;
  permissionMode: Exclude<ToolPermissionContext["mode"], "plan">;
  initialInput?: string;
  handoff: unknown;
};

export type DefaultExecutionMode = Extract<ToolPermissionContext["mode"], "default" | "fullAccess">;

export type KernelSession = {
  id: string;
  cwd: string;
  status: KernelStatus;
  messages: ModelMessage[];
  toolPermissionContext: ToolPermissionContext;
  defaultExecutionMode: DefaultExecutionMode;
  planState: PlanSessionState | null;
  workflowBinding: WorkflowBinding | null;
  pendingInteraction: PendingInteraction | null;
};

export type KernelSessionCheckpoint = Omit<KernelSession, "id" | "cwd">;

export type KernelIntent =
  | { type: "submit_user_message"; content: string }
  | { type: "resolve_plan_approval"; decision: "continue" | "stay"; metadata?: PlanApprovalResolveMetadata }
  | { type: "answer_user_question"; interactionId: string; answer: unknown }
  | { type: "resolve_tool_permission"; interactionId: string; decision: "allow_once" | "deny_once" };

export type KernelAction =
  | { type: "status_set"; status: KernelStatus }
  | { type: "messages_set"; messages: ModelMessage[] }
  | { type: "permissions_set"; permissions: ToolPermissionContext }
  | { type: "default_execution_mode_set"; mode: DefaultExecutionMode }
  | { type: "plan_state_set"; planState: PlanSessionState | null }
  | { type: "workflow_binding_set"; workflowBinding: WorkflowBinding | null }
  | { type: "pending_interaction_set"; interaction: PendingInteraction }
  | { type: "pending_interaction_cleared"; status?: KernelStatus }
  | { type: "intent_applied"; intent: KernelIntent };


export function createKernelSession(input: {
  id: string;
  cwd: string;
  permissions: ToolPermissionContext;
  messages?: ModelMessage[];
}): KernelSession {
  return {
    id: input.id,
    cwd: input.cwd,
    status: "idle_input",
    messages: input.messages?.slice() ?? [],
    toolPermissionContext: { ...input.permissions },
    defaultExecutionMode: defaultExecutionModeFrom(input.permissions.mode),
    planState: null,
    workflowBinding: null,
    pendingInteraction: null
  };
}

export function kernelSessionCheckpoint(session: KernelSession): KernelSessionCheckpoint {
  return {
    status: session.status,
    messages: session.messages.filter((message) => !message.metadata?.runtimeAttachment),
    toolPermissionContext: { ...session.toolPermissionContext },
    defaultExecutionMode: session.defaultExecutionMode,
    planState: session.planState ? { ...session.planState } : null,
    workflowBinding: session.workflowBinding ? { ...session.workflowBinding } : null,
    pendingInteraction: session.pendingInteraction ? { ...session.pendingInteraction } : null
  };
}

export function restoreKernelSession(input: {
  id: string;
  cwd: string;
  checkpoint: KernelSessionCheckpoint;
}): KernelSession {
  const checkpoint = kernelSessionCheckpoint({ id: input.id, cwd: input.cwd, ...input.checkpoint });
  return { id: input.id, cwd: input.cwd, ...checkpoint };
}

export function reduceKernelSession(session: KernelSession, action: KernelAction): KernelSession {
  if (action.type === "status_set") return { ...session, status: action.status };
  if (action.type === "messages_set") return { ...session, messages: action.messages.slice() };
  if (action.type === "permissions_set") return { ...session, toolPermissionContext: { ...action.permissions } };
  if (action.type === "default_execution_mode_set") return applyDefaultExecutionMode(session, action.mode);
  if (action.type === "plan_state_set") return { ...session, planState: action.planState };
  if (action.type === "workflow_binding_set") return { ...session, workflowBinding: action.workflowBinding };
  if (action.type === "pending_interaction_set") return { ...session, pendingInteraction: action.interaction, status: statusFor(action.interaction) };
  if (action.type === "pending_interaction_cleared") return { ...session, pendingInteraction: null, status: action.status ?? "idle_input" };
  return applyIntent(session, action.intent);
}



export function projectAppState(session: KernelSession) {
  return projectKernelAppState(session);
}

function applyIntent(session: KernelSession, intent: KernelIntent): KernelSession {
  if (intent.type === "submit_user_message") return { ...session, messages: [...session.messages, { role: "user", content: intent.content }] };
  return session;
}

function defaultExecutionModeFrom(mode: ToolPermissionContext["mode"]): DefaultExecutionMode {
  return mode === "fullAccess" ? "fullAccess" : "default";
}

function applyDefaultExecutionMode(session: KernelSession, mode: DefaultExecutionMode): KernelSession {
  if (session.toolPermissionContext.mode === "plan") return { ...session, defaultExecutionMode: mode };
  return {
    ...session,
    defaultExecutionMode: mode,
    toolPermissionContext: { ...session.toolPermissionContext, mode }
  };
}

function statusFor(interaction: PendingInteraction): KernelStatus {
  if (interaction.type === "tool_permission") return "waiting_tool_permission";
  if (interaction.type === "ask_user_question") return "waiting_user_input";
  if (interaction.type === "plan_approval") return "waiting_plan_approval";
  return "interrupted_restoring";
}

import type { ToolPermissionContext } from "../permissions/context.js";
import type { PlanRequestedPermission, PlanSessionState } from "../plans/planSession.js";
import type { ModelMessage } from "../providers/types.js";

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
  | { type: "plan_approval"; id: string; sessionId: string; document: string; planFilePath: string; empty?: boolean; requestedPermissions?: PlanRequestedPermission[] }
  | { type: "interrupt_confirmation"; id: string; sessionId: string; message: string };

export type WorkflowBinding = {
  runId: string;
  status: "pending" | "running" | "waiting" | "completed";
  approvalId?: string;
  planHash?: string;
};

export type KernelSession = {
  id: string;
  cwd: string;
  status: KernelStatus;
  messages: ModelMessage[];
  toolPermissionContext: ToolPermissionContext;
  planState: PlanSessionState | null;
  workflowBinding: WorkflowBinding | null;
  pendingInteraction: PendingInteraction | null;
};

export type KernelAction =
  | { type: "status_set"; status: KernelStatus }
  | { type: "messages_set"; messages: ModelMessage[] }
  | { type: "permissions_set"; permissions: ToolPermissionContext }
  | { type: "plan_state_set"; planState: PlanSessionState | null }
  | { type: "workflow_binding_set"; workflowBinding: WorkflowBinding | null }
  | { type: "pending_interaction_set"; interaction: PendingInteraction }
  | { type: "pending_interaction_cleared"; status?: KernelStatus };

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
    planState: null,
    workflowBinding: null,
    pendingInteraction: null
  };
}

export function reduceKernelSession(session: KernelSession, action: KernelAction): KernelSession {
  if (action.type === "status_set") return { ...session, status: action.status };
  if (action.type === "messages_set") return { ...session, messages: action.messages.slice() };
  if (action.type === "permissions_set") return { ...session, toolPermissionContext: { ...action.permissions } };
  if (action.type === "plan_state_set") return { ...session, planState: action.planState };
  if (action.type === "workflow_binding_set") return { ...session, workflowBinding: action.workflowBinding };
  if (action.type === "pending_interaction_set") {
    return { ...session, pendingInteraction: action.interaction, status: statusFor(action.interaction) };
  }
  return { ...session, pendingInteraction: null, status: action.status ?? "idle_input" };
}

export function projectAppState(session: KernelSession) {
  return {
    id: session.id,
    status: session.status,
    pendingInteraction: session.pendingInteraction,
    planState: session.planState,
    workflowBinding: session.workflowBinding,
    messageCount: session.messages.length
  };
}

function statusFor(interaction: PendingInteraction): KernelStatus {
  if (interaction.type === "tool_permission") return "waiting_tool_permission";
  if (interaction.type === "ask_user_question") return "waiting_user_input";
  if (interaction.type === "plan_approval") return "waiting_plan_approval";
  return "interrupted_restoring";
}

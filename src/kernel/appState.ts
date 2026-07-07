import type { DefaultExecutionMode, KernelSession, PendingInteraction, WorkflowBinding } from "./session.js";
import type { PlanSessionState } from "../plans/planSession.js";

export type KernelAppState = {
  id: string;
  status: KernelSession["status"];
  pendingInteraction: PendingInteraction | null;
  planState: PlanSessionState | null;
  workflowBinding: WorkflowBinding | null;
  messageCount: number;
  permissionMode: KernelSession["toolPermissionContext"]["mode"];
  defaultExecutionMode: DefaultExecutionMode;
};

export function projectKernelAppState(session: KernelSession): KernelAppState {
  return {
    id: session.id,
    status: session.status,
    pendingInteraction: session.pendingInteraction,
    planState: session.planState,
    workflowBinding: session.workflowBinding,
    messageCount: session.messages.length,
    permissionMode: session.toolPermissionContext.mode,
    defaultExecutionMode: session.defaultExecutionMode
  };
}

import { randomUUID } from "node:crypto";
import type { PlanRequestedPermission } from "../plans/planSession.js";
import type { PendingInteraction } from "./session.js";

export type PlanApprovalPendingInput = {
  sessionId: string;
  planFilePath: string;
  planHash: string;
  requestedPermissions?: PlanRequestedPermission[];
  empty?: boolean;
  toolCallId?: string;
};

export function createPlanApprovalPending(input: PlanApprovalPendingInput): Extract<PendingInteraction, { type: "plan_approval" }> {
  return {
    type: "plan_approval",
    id: randomUUID(),
    sessionId: input.sessionId,

    planFilePath: input.planFilePath,
    planHash: input.planHash,
    empty: input.empty,
    requestedPermissions: input.requestedPermissions ?? [],
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {})
  };
}

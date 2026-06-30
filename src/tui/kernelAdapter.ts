import type { KernelSession, PendingInteraction } from "../kernel/session.js";
import { projectAppState } from "../kernel/session.js";

type PlanApprovalInteraction = Extract<PendingInteraction, { type: "plan_approval" }>;

export function createTuiKernelAdapter(session: KernelSession): {
  appState: ReturnType<typeof projectAppState>;
  planReview: PlanApprovalInteraction | null;
} {
  return {
    appState: projectAppState(session),
    planReview: session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction : null
  };
}

import type { KernelIntent, KernelSession, PendingInteraction, PlanApprovalResolveMetadata } from "../kernel/session.js";
import { projectKernelAppState } from "../kernel/appState.js";

type PlanApprovalInteraction = Extract<PendingInteraction, { type: "plan_approval" }>;

export function createTuiKernelAdapter(session: KernelSession): {
  appState: ReturnType<typeof projectKernelAppState>;
  planReview: PlanApprovalInteraction | null;
  planApprovalIntent: (decision: "continue" | "stay", metadata?: PlanApprovalResolveMetadata) => KernelIntent;
} {
  return {
    appState: projectKernelAppState(session),
    planReview: session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction : null,
    planApprovalIntent: (decision, metadata) => metadata === undefined
      ? { type: "resolve_plan_approval", decision }
      : { type: "resolve_plan_approval", decision, metadata }
  };
}

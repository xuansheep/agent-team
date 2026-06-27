import { PermissionMode } from "../permissions/PermissionMode.js";
import { ToolPermissionContext } from "../permissions/context.js";
import { PlanApprovalRequest, PlanModeEvent } from "../runtime/types.js";
import { getPlanFilePath, readPlan } from "./planFiles.js";

export type PlanSessionState = {
  mode: "inactive" | "planning" | "waiting_approval";
  sessionId: string;
  planFilePath: string;
  prePlanMode: PermissionMode;
  originalInput: unknown;
  approvedPlan?: string;
  feedbackMessages?: unknown[];
};

export type EnterPlanModeInput = {
  sessionId: string;
  cwd?: string;
  plansDirectory?: string;
  originalInput: unknown;
  permissions: ToolPermissionContext;
};

export function enterPlanMode(input: EnterPlanModeInput): { state: PlanSessionState; permissions: ToolPermissionContext; event: PlanModeEvent } {
  const prePlanMode = input.permissions.mode === "plan" ? input.permissions.prePlanMode ?? "default" : input.permissions.mode;
  const planFilePath = input.permissions.planFilePath ?? getPlanFilePath(input.sessionId, input.cwd, input.plansDirectory);
  const state: PlanSessionState = {
    mode: "planning",
    sessionId: input.sessionId,
    planFilePath,
    prePlanMode,
    originalInput: input.originalInput,
    feedbackMessages: []
  };
  return {
    state,
    permissions: { ...input.permissions, mode: "plan", prePlanMode, planFilePath },
    event: { type: "plan_mode_entered", session_id: input.sessionId, plan_file_path: planFilePath }
  };
}

export async function exitPlanMode(state: PlanSessionState): Promise<{ state: PlanSessionState; plan: PlanApprovalRequest; event: PlanModeEvent }> {
  const document = (await readPlan(state.planFilePath))?.trim();
  if (!document) throw new Error(`Plan file is empty or missing: ${state.planFilePath}`);
  const next: PlanSessionState = { ...state, mode: "waiting_approval" };
  return {
    state: next,
    plan: { sessionId: state.sessionId, document, planFilePath: state.planFilePath },
    event: { type: "plan_approval_requested", session_id: state.sessionId, document, plan_file_path: state.planFilePath }
  };
}

export function resolvePlanApproval(
  state: PlanSessionState,
  decision: "continue" | "stay",
  feedback?: unknown
): { state: PlanSessionState; permissions: ToolPermissionContext; event: PlanModeEvent } {
  if (decision === "continue") {
    const approvedPlan = state.approvedPlan ?? "";
    return {
      state: { ...state, mode: "inactive", approvedPlan },
      permissions: { mode: state.prePlanMode, allow: [], ask: [], deny: [] },
      event: { type: "plan_approval_resolved", session_id: state.sessionId, decision: "continue" }
    };
  }
  return {
    state: {
      ...state,
      mode: "planning",
      feedbackMessages: feedback === undefined ? state.feedbackMessages ?? [] : [...state.feedbackMessages ?? [], feedback]
    },
    permissions: { mode: "plan", prePlanMode: state.prePlanMode, allow: [], ask: [], deny: [], planFilePath: state.planFilePath },
    event: { type: "plan_approval_resolved", session_id: state.sessionId, decision: "stay" }
  };
}

export function approvePlan(state: PlanSessionState, approvedPlan: string): PlanSessionState {
  return { ...state, mode: "inactive", approvedPlan };
}

export function buildApprovedPlanHandoff(state: PlanSessionState): unknown {
  if (!state.approvedPlan?.trim()) throw new Error("Cannot build workflow handoff without an approved plan");
  return { original_input: state.originalInput, approved_plan: state.approvedPlan };
}

export async function runWorkflowAfterPlanApproval<T>(state: PlanSessionState, startWorkflow: (handoff: unknown) => Promise<T>): Promise<T> {
  if (state.mode !== "inactive" || !state.approvedPlan?.trim()) {
    throw new Error("Plan must be approved before workflow execution starts");
  }
  return startWorkflow(buildApprovedPlanHandoff(state));
}

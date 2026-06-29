import { isAbsolute, resolve } from "node:path";
import { PermissionMode } from "../permissions/PermissionMode.js";
import { ToolPermissionContext } from "../permissions/context.js";
import { ModelMessage } from "../providers/types.js";
import { PlanApprovalRequest, PlanModeEvent } from "../runtime/types.js";
import { getPlanFilePath, readPlan, writePlan } from "./planFiles.js";

export type PlanSessionState = {
  mode: "inactive" | "planning" | "waiting_approval";
  sessionId: string;
  planFilePath: string;
  prePlanMode: PermissionMode;
  originalInput: unknown;
  approvedPlan?: string;
  approvedPlanFeedback?: unknown;
  emptyPlanApproved?: boolean;
  reentry?: boolean;
  useAutoModeDuringPlan?: boolean;
  requestedPermissions?: PlanRequestedPermission[];
  feedbackMessages?: unknown[];
};

export type PlanRequestedPermission = {
  tool: string;
  prompt: string;
};

export const planModeExitHandoffMarker = "__agent_team_plan_mode_exit";
export const planModeExitPlanExistsMarker = "__agent_team_plan_mode_exit_plan_exists";

export type EnterPlanModeInput = {
  sessionId: string;
  cwd?: string;
  plansDirectory?: string;
  originalInput: unknown;
  permissions: ToolPermissionContext;
  reentry?: boolean;
  useAutoModeDuringPlan?: boolean;
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
    ...(input.reentry ? { reentry: true } : {}),
    useAutoModeDuringPlan: input.useAutoModeDuringPlan ?? input.permissions.planUseAutoMode ?? true,
    feedbackMessages: []
  };
  return {
    state,
    permissions: { ...input.permissions, mode: "plan", prePlanMode, planFilePath, planUseAutoMode: state.useAutoModeDuringPlan },
    event: { type: "plan_mode_entered", session_id: input.sessionId, plan_file_path: planFilePath }
  };
}

export async function exitPlanMode(state: PlanSessionState, input: { requestedPermissions?: PlanRequestedPermission[] } = {}): Promise<{ state: PlanSessionState; plan: PlanApprovalRequest; event: PlanModeEvent }> {
  const document = (await readPlan(state.planFilePath))?.trim() ?? "";
  const requestedPermissions = input.requestedPermissions ?? state.requestedPermissions;
  const empty = !document.trim();
  const next: PlanSessionState = { ...state, mode: "waiting_approval", requestedPermissions };
  return {
    state: next,
    plan: { sessionId: state.sessionId, document, planFilePath: state.planFilePath, ...(empty ? { empty: true } : {}), ...(requestedPermissions?.length ? { requestedPermissions } : {}) },
    event: { type: "plan_approval_requested", session_id: state.sessionId, document, plan_file_path: state.planFilePath, ...(empty ? { empty: true } : {}), ...(requestedPermissions?.length ? { requested_permissions: requestedPermissions } : {}) }
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
    permissions: { mode: "plan", prePlanMode: state.prePlanMode, allow: [], ask: [], deny: [], planFilePath: state.planFilePath, planUseAutoMode: state.useAutoModeDuringPlan },
    event: { type: "plan_approval_resolved", session_id: state.sessionId, decision: "stay" }
  };
}

export function approvePlan(state: PlanSessionState, approvedPlan: string, feedback?: unknown): PlanSessionState {
  return { ...state, mode: "inactive", approvedPlan, ...(feedback === undefined ? {} : { approvedPlanFeedback: feedback }), emptyPlanApproved: !approvedPlan.trim() };
}

export function buildApprovedPlanHandoff(state: PlanSessionState): unknown {
  if (!state.approvedPlan?.trim()) {
    if (state.emptyPlanApproved) return markPlanModeExitHandoff(state.originalInput, false);
    throw new Error("Cannot build workflow handoff without an approved plan");
  }
  return {
    original_input: state.originalInput,
    approved_plan: state.approvedPlan,
    plan_file_path: state.planFilePath,
    ...(state.approvedPlanFeedback !== undefined ? { plan_approval_feedback: state.approvedPlanFeedback } : {}),
    ...(state.requestedPermissions?.length ? { plan_requested_permissions: state.requestedPermissions } : {})
  };
}

export async function runWorkflowAfterPlanApproval<T>(state: PlanSessionState, startWorkflow: (handoff: unknown) => Promise<T>): Promise<T> {
  if (state.mode !== "inactive" || (!state.approvedPlan?.trim() && !state.emptyPlanApproved)) {
    throw new Error("Plan must be approved before workflow execution starts");
  }
  return startWorkflow(buildApprovedPlanHandoff(state));
}

export function stripInternalPlanModeHandoffMarkers(handoff: unknown): unknown {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return handoff;
  const value = { ...handoff as Record<string, unknown> };
  delete value[planModeExitHandoffMarker];
  delete value[planModeExitPlanExistsMarker];
  return value;
}

function markPlanModeExitHandoff(input: unknown, planExists: boolean): unknown {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { ...input, [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: planExists };
  }
  return { request: input, [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: planExists };
}

export async function readPlanOrRecoverFromTranscript(input: { planFilePath: string; cwd: string; messages: ModelMessage[] }): Promise<string | undefined> {
  const existing = await readPlan(input.planFilePath);
  if (existing !== undefined) return existing;

  const recovered = recoverPlanFromTranscript(input.messages, input.planFilePath, input.cwd);
  if (recovered === undefined) return undefined;
  await writePlan(input.planFilePath, recovered);
  return recovered;
}

export function recoverPlanFromTranscript(messages: ModelMessage[], planFilePath: string, cwd: string): string | undefined {
  const target = resolve(planFilePath);
  let recovered: string | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      const input = objectInput(call.input);
      if (!input) continue;

      if (call.name === "ExitPlanMode" && typeof input.plan === "string" && input.plan.length) {
        recovered = input.plan;
        continue;
      }

      if (!toolPathMatchesPlan(input.file_path, target, cwd)) continue;
      if (call.name === "Write" && typeof input.content === "string") {
        recovered = input.content;
        continue;
      }
      if (call.name === "Edit" && recovered !== undefined) {
        recovered = applyEdit(recovered, input);
        continue;
      }
      if (call.name === "MultiEdit" && recovered !== undefined && Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          recovered = applyEdit(recovered, objectInput(edit));
        }
      }
    }
  }
  return recovered;
}

function toolPathMatchesPlan(value: unknown, planFilePath: string, cwd: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const toolPath = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return toolPath === planFilePath;
}

function applyEdit(current: string, input: Record<string, unknown> | undefined): string {
  if (!input || typeof input.old_string !== "string" || typeof input.new_string !== "string") return current;
  return current.includes(input.old_string) ? current.replace(input.old_string, input.new_string) : current;
}

function objectInput(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

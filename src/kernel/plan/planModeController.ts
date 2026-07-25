import { createHash } from "node:crypto";
import {
  approvePlan,
  buildApprovedPlanHandoff as buildLegacyHandoff,
  enterPlanMode,
  exitPlanMode,
  resolvePlanApproval,
  type PlanSessionState
} from "../../plans/planSession.js";
import { readPlan } from "../../plans/planFiles.js";
import { readRequiredPlan } from "../../plans/planGuards.js";
import type { PlanApprovalRequest } from "../../runtime/types.js";
import type { KernelExecutionHandoff, KernelSession, PlanApprovalResolveMetadata } from "../session.js";
import { reduceKernelSession } from "../session.js";
import { createPlanApprovalPending } from "../pendingInteraction.js";
import { closeDanglingExitPlanModeToolCalls, planApprovalToolResultContent } from "./planToolCallMessages.js";

export type ExitPlanModeRequest = {
  requestedPermissions?: { tool: string; prompt: string }[];
  toolCallId?: string;
};

export type ApprovedPlanHandoff = {
  sessionId: string;
  approvalId: string;
  planFilePath: string;
  planText: string;
  planHash: string;
  originalInput: unknown;
  legacyHandoff: unknown;
};

export type PlanApprovalResolutionResult = {
  session: KernelSession;
  execution?: KernelExecutionHandoff;
};

export class PlanModeController {
  enterPlanMode(session: KernelSession, originalInput: unknown): KernelSession {
    const entered = enterPlanMode({ sessionId: session.id, cwd: session.cwd, originalInput, permissions: session.toolPermissionContext });
    return { ...session, status: "planning", planState: entered.state, toolPermissionContext: entered.permissions };
  }

  async requestPlanApproval(session: KernelSession, request: ExitPlanModeRequest = {}): Promise<KernelSession> {
    if (!session.planState || session.planState.mode !== "planning") throw new Error("Plan Mode is not active");
    const exited = await exitPlanMode(session.planState, { requestedPermissions: request.requestedPermissions });
    return this.adoptPlanApproval(session, {
      planState: exited.state,
      plan: { ...exited.plan, toolCallId: request.toolCallId }
    });
  }

  async adoptPlanApproval(session: KernelSession, input: { planState: PlanSessionState; plan: PlanApprovalRequest }): Promise<KernelSession> {
    if (input.planState.mode !== "waiting_approval") throw new Error("Plan approval state must be waiting_approval");
    if (input.plan.sessionId !== session.id || input.planState.sessionId !== session.id) {
      throw new Error(`Plan approval session mismatch for ${session.id}`);
    }
    if (input.plan.planFilePath !== input.planState.planFilePath) {
      throw new Error(`Plan approval file mismatch for ${session.id}`);
    }
    const document = await readRequiredPlan(input.plan.planFilePath);
    const planHash = hashText(document);
    const interaction = createPlanApprovalPending({
      sessionId: session.id,
      planFilePath: input.plan.planFilePath,
      planHash,
      empty: input.plan.empty ?? !document,
      requestedPermissions: input.plan.requestedPermissions,
      toolCallId: input.plan.toolCallId
    });
    const planState: PlanSessionState = {
      ...input.planState,
      requestedPermissions: input.plan.requestedPermissions,
      approvalId: interaction.id,
      approvedPlanHash: planHash,
      approvalToolCallId: input.plan.toolCallId
    };
    return reduceKernelSession({ ...session, planState }, { type: "pending_interaction_set", interaction });
  }

  async resolvePlanApproval(session: KernelSession, input: { decision: "continue" | "stay" } & PlanApprovalResolveMetadata): Promise<PlanApprovalResolutionResult> {
    if (!session.planState || session.planState.mode !== "waiting_approval") {
      throw new Error("Plan approval is not pending");
    }
    if (session.pendingInteraction?.type !== "plan_approval") {
      throw new Error("Plan approval interaction is not pending");
    }
    if (session.pendingInteraction.sessionId !== session.id || session.pendingInteraction.planFilePath !== session.planState.planFilePath) {
      throw new Error(`Plan approval interaction mismatch for ${session.id}`);
    }
    if (input.decision === "continue") {
      const sessionWithToolResult = closePlanApprovalToolCall(session, "continue", input.feedback);
      const document = await readRequiredPlan(session.planState.planFilePath);
      const approved = approvePlan(session.planState, document, input.feedback);
      const resolved = resolvePlanApproval(approved, "continue");
      const restoredPermissions = { ...resolved.permissions, mode: restoredExecutionPermissionMode(session, resolved.permissions.mode) };
      const nextSession = reduceKernelSession({ ...sessionWithToolResult, planState: resolved.state, toolPermissionContext: restoredPermissions }, {
        type: "pending_interaction_cleared",
        status: "idle_input"
      });
      const handoff = this.buildApprovedPlanHandoff(nextSession);
      const permissionMode = input.permissionMode ?? nonPlanPermissionMode(restoredPermissions.mode);
      const clearContext = input.clearContext === true;
      return {
        session: nextSession,
        execution: {
          clearContext,
          permissionMode,
          ...(clearContext ? { initialInput: freshImplementationInput(handoff.planText, session.planState.originalInput, input.feedback) } : {}),
          handoff
        }
      };
    }
    const sessionWithToolResult = closePlanApprovalToolCall(session, "stay", input.feedback);
    const resolved = resolvePlanApproval(session.planState, "stay", input.feedback);
    return {
      session: reduceKernelSession({ ...sessionWithToolResult, planState: resolved.state, toolPermissionContext: resolved.permissions }, {
        type: "pending_interaction_cleared",
        status: "planning"
      })
    };
  }

  buildApprovedPlanHandoff(session: KernelSession): ApprovedPlanHandoff {
    if (!session.planState) throw new Error("Plan Mode is not active");
    const planText = session.planState.approvedPlan ?? "";
    const planHash = hashText(planText);
    return {
      sessionId: session.id,
      approvalId: session.planState.approvalId ?? (session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction.id : `${session.id}:approved:${planHash}`),
      planFilePath: session.planState.planFilePath,
      planText,
      planHash,
      originalInput: session.planState.originalInput,
      legacyHandoff: buildLegacyHandoff(session.planState)
    };
  }

  async recoverPlanDocument(session: KernelSession): Promise<string | undefined> {
    if (!session.planState) return undefined;
    return readPlan(session.planState.planFilePath);
  }
}

function closePlanApprovalToolCall(session: KernelSession, decision: "continue" | "stay", feedback: unknown): KernelSession {
  const content = planApprovalToolResultContent({ decision, feedback });
  return { ...session, messages: closeDanglingExitPlanModeToolCalls(session.messages, content) };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freshImplementationInput(planText: string, originalInput: unknown, feedback: unknown): string {
  const parts = [`Implement the following plan:\n\n${planText.trim()}`];
  parts.push(`\nOriginal input:\n${JSON.stringify(originalInput, null, 2)}`);
  if (typeof feedback === "string" && feedback.trim()) parts.push(`\nApproval feedback:\n${feedback.trim()}`);
  return parts.join("\n");
}

function restoredExecutionPermissionMode(session: KernelSession, resolvedMode: KernelSession["toolPermissionContext"]["mode"]): KernelSession["toolPermissionContext"]["mode"] {
  const prePlanMode = session.planState?.prePlanMode ?? resolvedMode;
  return session.defaultExecutionMode === defaultExecutionModeFrom(prePlanMode)
    ? resolvedMode
    : session.defaultExecutionMode;
}

function defaultExecutionModeFrom(mode: KernelSession["toolPermissionContext"]["mode"]): KernelSession["defaultExecutionMode"] {
  return mode === "fullAccess" ? "fullAccess" : "default";
}

function nonPlanPermissionMode(mode: string): Exclude<PlanApprovalResolveMetadata["permissionMode"], undefined> {
  return mode === "plan" ? "default" : mode as Exclude<PlanApprovalResolveMetadata["permissionMode"], undefined>;
}

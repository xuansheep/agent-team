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

type PlanApprovalMetadata = {
  approvalId?: string;
  approvedPlanHash?: string;
  approvalToolCallId?: string;
};

export class PlanModeController {
  enterPlanMode(session: KernelSession, originalInput: unknown): KernelSession {
    const entered = enterPlanMode({ sessionId: session.id, cwd: session.cwd, originalInput, permissions: session.toolPermissionContext });
    return { ...session, status: "planning", planState: entered.state, toolPermissionContext: entered.permissions };
  }

  async requestPlanApproval(session: KernelSession, request: ExitPlanModeRequest = {}): Promise<KernelSession> {
    if (!session.planState || session.planState.mode !== "planning") throw new Error("Plan Mode is not active");
    const exited = await exitPlanMode(session.planState, { requestedPermissions: request.requestedPermissions });
    const document = (await readPlan(exited.plan.planFilePath))?.trim() ?? "";
    const planHash = hashText(document);
    const interaction = createPlanApprovalPending({
      sessionId: session.id,
      planFilePath: exited.plan.planFilePath,
      planHash,
      empty: exited.plan.empty,
      requestedPermissions: exited.plan.requestedPermissions,
      toolCallId: request.toolCallId
    });
    const planState = withApprovalMetadata(exited.state, { approvalId: interaction.id, approvedPlanHash: planHash, approvalToolCallId: request.toolCallId });
    return reduceKernelSession({ ...session, planState }, { type: "pending_interaction_set", interaction });
  }

  async resolvePlanApproval(session: KernelSession, input: { decision: "continue" | "stay" } & PlanApprovalResolveMetadata): Promise<PlanApprovalResolutionResult> {
    if (!session.planState) throw new Error("Plan Mode is not active");
    if (input.decision === "continue") {
      const sessionWithToolResult = closePlanApprovalToolCall(session, "continue", input.feedback);
      const document = (await readPlan(session.planState.planFilePath))?.trim() ?? "";
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
    const metadata = approvalMetadata(session.planState);
    return {
      sessionId: session.id,
      approvalId: metadata.approvalId ?? (session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction.id : `${session.id}:approved:${planHash}`),
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

function withApprovalMetadata(state: PlanSessionState, metadata: PlanApprovalMetadata): PlanSessionState {
  return { ...state, ...metadata } as PlanSessionState;
}

function approvalMetadata(state: PlanSessionState): PlanApprovalMetadata {
  return state as PlanSessionState & PlanApprovalMetadata;
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
  return mode === "bypassPermissions" ? "bypassPermissions" : "default";
}

function nonPlanPermissionMode(mode: string): Exclude<PlanApprovalResolveMetadata["permissionMode"], undefined> {
  return mode === "plan" ? "default" : mode as Exclude<PlanApprovalResolveMetadata["permissionMode"], undefined>;
}

import { createHash, randomUUID } from "node:crypto";
import {
  approvePlan,
  buildApprovedPlanHandoff as buildLegacyHandoff,
  enterPlanMode,
  exitPlanMode,
  resolvePlanApproval
} from "../../plans/planSession.js";
import { readPlan, writePlan } from "../../plans/planFiles.js";
import type { KernelSession } from "../session.js";
import { reduceKernelSession } from "../session.js";

export type ExitPlanModeRequest = {
  plan?: string;
  requestedPermissions?: { tool: string; prompt: string }[];
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

export class PlanModeController {
  enterPlanMode(session: KernelSession, originalInput: unknown): KernelSession {
    const entered = enterPlanMode({
      sessionId: session.id,
      cwd: session.cwd,
      originalInput,
      permissions: session.toolPermissionContext
    });
    return {
      ...session,
      status: "planning",
      planState: entered.state,
      toolPermissionContext: entered.permissions
    };
  }

  async requestPlanApproval(session: KernelSession, request: ExitPlanModeRequest = {}): Promise<KernelSession> {
    if (!session.planState || session.planState.mode !== "planning") throw new Error("Plan Mode is not active");
    if (request.plan !== undefined) await writePlan(session.planState.planFilePath, request.plan);
    const exited = await exitPlanMode(session.planState, { requestedPermissions: request.requestedPermissions });
    return reduceKernelSession({ ...session, planState: exited.state }, {
      type: "pending_interaction_set",
      interaction: {
        type: "plan_approval",
        id: randomUUID(),
        sessionId: session.id,
        document: exited.plan.document,
        planFilePath: exited.plan.planFilePath,
        empty: exited.plan.empty,
        requestedPermissions: exited.plan.requestedPermissions
      }
    });
  }

  resolvePlanApproval(session: KernelSession, input: { decision: "continue" | "stay"; feedback?: unknown }): KernelSession {
    if (!session.planState) throw new Error("Plan Mode is not active");
    if (input.decision === "continue") {
      const document = session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction.document : "";
      const resolved = resolvePlanApproval(approvePlan(session.planState, document, input.feedback), "continue");
      return reduceKernelSession({ ...session, planState: resolved.state, toolPermissionContext: resolved.permissions }, {
        type: "pending_interaction_cleared",
        status: "idle_input"
      });
    }
    const resolved = resolvePlanApproval(session.planState, "stay", input.feedback);
    return reduceKernelSession({ ...session, planState: resolved.state, toolPermissionContext: resolved.permissions }, {
      type: "pending_interaction_cleared",
      status: "planning"
    });
  }

  buildApprovedPlanHandoff(session: KernelSession): ApprovedPlanHandoff {
    if (!session.planState) throw new Error("Plan Mode is not active");
    const planText = session.planState.approvedPlan ?? "";
    return {
      sessionId: session.id,
      approvalId: session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction.id : `${session.id}:approved`,
      planFilePath: session.planState.planFilePath,
      planText,
      planHash: hashText(planText),
      originalInput: session.planState.originalInput,
      legacyHandoff: buildLegacyHandoff(session.planState)
    };
  }

  async recoverPlanDocument(session: KernelSession): Promise<string | undefined> {
    if (!session.planState) return undefined;
    return readPlan(session.planState.planFilePath);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

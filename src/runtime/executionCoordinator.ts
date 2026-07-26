import type { AgentTeamConfig } from "../config/schema.js";
import { PlanModeController, type PlanApprovalResolutionResult } from "../kernel/plan/planModeController.js";
import { closeDanglingExitPlanModeToolCalls, planApprovalToolResultContent } from "../kernel/plan/planToolCallMessages.js";
import { reduceKernelSession, type KernelSession, type PlanApprovalResolveMetadata } from "../kernel/session.js";
import type { RuntimeTurnInput, RuntimeTurnResult } from "./types.js";
import { TurnEngine } from "./turnEngine.js";
import type { RunSummary } from "../storage/runStore.js";
import type { SessionStore } from "../storage/sessionStore.js";
import { WorkflowEngine, type WorkflowRunOptions } from "../workflow/engine.js";
import type { WorkflowSession } from "../workflow/session.js";
import type { WorkflowState } from "../workflow/state.js";

export type SessionTurnInput = Omit<
  RuntimeTurnInput,
  "messages" | "permissions" | "cwd" | "sessionId" | "runId" | "planState"
> & {
  session: KernelSession;
};

export type SessionTurnResult = {
  session: KernelSession;
  outcome: RuntimeTurnResult;
};

export type ExecutionStartInput =
  | { stage: "plan"; turn: SessionTurnInput }
  | {
      stage: "workflow";
      config: AgentTeamConfig;
      workflowId: string;
      input: unknown;
      options?: WorkflowRunOptions;
    };

export type ExecutionStartResult =
  | ({ stage: "plan" } & SessionTurnResult)
  | { stage: "workflow"; session: WorkflowSession };

export type ExecutionCoordinatorOptions = {
  turnEngine?: TurnEngine;
  sessionStore?: SessionStore;
};

export type PlanWorkflowTransitionInput = {
  session: KernelSession;
  config: AgentTeamConfig;
  workflowId: string;
  permissionMode?: PlanApprovalResolveMetadata["permissionMode"];
  clearContext?: boolean;
  feedback?: unknown;
};

export type PlanWorkflowTransitionResult = {
  resolution: PlanApprovalResolutionResult;
  workflow: WorkflowSession;
};

export class ExecutionCoordinator {
  private readonly turnEngine: TurnEngine;
  private readonly planMode = new PlanModeController();
  private readonly sessionStore?: SessionStore;

  constructor(
    private readonly workflowEngine?: WorkflowEngine,
    options: ExecutionCoordinatorOptions = {}
  ) {
    this.turnEngine = options.turnEngine ?? new TurnEngine();
    this.sessionStore = options.sessionStore;
  }

  async start(input: ExecutionStartInput): Promise<ExecutionStartResult> {
    if (input.stage === "plan") {
      return { stage: "plan", ...await this.executeSession(input.turn) };
    }
    return {
      stage: "workflow",
      session: await this.requireWorkflowEngine().startInteractive(
        input.config,
        input.workflowId,
        input.input,
        input.options
      )
    };
  }

  execute(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    return this.turnEngine.execute(input);
  }

  runPlanTurn(input: SessionTurnInput): Promise<SessionTurnResult> {
    return this.executeSession(input);
  }

  async executeSession(input: SessionTurnInput): Promise<SessionTurnResult> {
    if (input.session.pendingInteraction) {
      throw new Error(`Session ${input.session.id} has unresolved interaction ${input.session.pendingInteraction.id}`);
    }
    const preparedSession: KernelSession = {
      ...input.session,
      status: input.session.toolPermissionContext.mode === "plan" ? "planning" : "running_query",
      messages: closeDanglingExitPlanModeToolCalls(
        input.session.messages,
        planApprovalToolResultContent({ decision: "repair" })
      )
    };
    await this.persistSession(preparedSession);
    const outcome = await this.turnEngine.execute({
      ...input,
      messages: preparedSession.messages,
      permissions: preparedSession.toolPermissionContext,
      cwd: preparedSession.cwd,
      sessionId: preparedSession.id,
      runId: preparedSession.workflowBinding?.runId,
      planState: preparedSession.planState ?? undefined
    });
    const session = await this.projectTurnOutcome(preparedSession, outcome);
    await this.persistSession(session);
    return { session, outcome };
  }

  async resolvePlanApproval(
    session: KernelSession,
    input: { decision: "continue" | "stay" } & PlanApprovalResolveMetadata
  ): Promise<PlanApprovalResolutionResult> {
    const resolved = await this.planMode.resolvePlanApproval(session, input);
    await this.persistSession(resolved.session);
    return resolved;
  }

  async resolvePlanApprovalAndStart(input: PlanWorkflowTransitionInput): Promise<PlanWorkflowTransitionResult> {
    const resolved = await this.planMode.resolvePlanApproval(input.session, {
      decision: "continue",
      permissionMode: input.permissionMode,
      clearContext: input.clearContext,
      feedback: input.feedback
    });
    if (!resolved.execution) throw new Error(`Session ${input.session.id} did not produce an execution handoff`);

    const execution = resolved.execution;
    const handoff = execution.handoff as { approvalId?: string; planHash?: string; legacyHandoff?: unknown };
    const workflowInput = execution.clearContext
      ? execution.initialInput
      : handoff.legacyHandoff;
    if (workflowInput === undefined) throw new Error(`Session ${input.session.id} produced an empty workflow handoff`);

    let workflow: WorkflowSession;
    try {
      workflow = await this.requireWorkflowEngine().startInteractive(
        input.config,
        input.workflowId,
        workflowInput,
        {
          permissionMode: execution.permissionMode,
          clearContext: execution.clearContext,
          sessionId: resolved.session.id
        }
      );
    } catch (error) {
      await this.persistSession(input.session);
      throw error;
    }

    const boundSession: KernelSession = {
      ...resolved.session,
      status: "running_workflow",
      workflowBinding: {
        runId: workflow.runId,
        status: "running",
        ...(handoff.approvalId ? { approvalId: handoff.approvalId } : {}),
        ...(handoff.planHash ? { planHash: handoff.planHash } : {})
      }
    };
    const resolution = { ...resolved, session: boundSession };
    if (this.sessionStore) await this.sessionStore.attachRun(boundSession.id, workflow.runId);
    await this.persistSession(boundSession);
    const sessionStore = this.sessionStore;
    if (sessionStore) {
      workflow.result = workflow.result.then(async (state) => {
        if (state.status === "completed") {
          await sessionStore.syncWorkflowRunStatus(boundSession.id, workflow.runId, "completed");
        }
        return state;
      });
    }
    return { resolution, workflow };
  }

  run(
    config: AgentTeamConfig,
    workflowId: string,
    input: unknown,
    options: WorkflowRunOptions = {}
  ): Promise<WorkflowState> {
    return this.requireWorkflowEngine().run(config, workflowId, input, options);
  }

  resume(
    config: AgentTeamConfig,
    workflowId: string,
    runId: string,
    userInput: unknown
  ): Promise<WorkflowState> {
    return this.requireWorkflowEngine().resume(config, workflowId, runId, userInput);
  }

  startInteractive(
    config: AgentTeamConfig,
    workflowId: string,
    input: unknown,
    options: WorkflowRunOptions = {}
  ): Promise<WorkflowSession> {
    return this.requireWorkflowEngine().startInteractive(config, workflowId, input, options);
  }

  resumeInteractive(config: AgentTeamConfig, runId: string): Promise<WorkflowSession> {
    return this.requireWorkflowEngine().resumeInteractive(config, runId);
  }

  listRuns(options: { limit?: number } = {}): Promise<RunSummary[]> {
    return this.requireWorkflowEngine().listRuns(options);
  }

  private async projectTurnOutcome(session: KernelSession, outcome: RuntimeTurnResult): Promise<KernelSession> {
    const base: KernelSession = {
      ...session,
      messages: outcome.messages,
      planState: outcome.planState ?? session.planState
    };
    if (outcome.status === "waiting_permission") {
      return reduceKernelSession(base, {
        type: "pending_interaction_set",
        interaction: {
          type: "tool_permission",
          id: outcome.request.toolCallId,
          sessionId: session.id,
          runId: session.workflowBinding?.runId,
          tool: outcome.request.tool,
          input: outcome.request.input,
          reason: outcome.request.reason,
          rule: outcome.request.rule
        }
      });
    }
    if (outcome.status === "waiting_user_input") {
      return reduceKernelSession(base, {
        type: "pending_interaction_set",
        interaction: {
          type: "ask_user_question",
          id: outcome.request.toolCallId,
          sessionId: session.id,
          runId: session.workflowBinding?.runId,
          toolCallId: outcome.request.toolCallId,
          questions: outcome.request.questions
        }
      });
    }
    if (outcome.status === "waiting_plan_approval") {
      return this.planMode.adoptPlanApproval(base, {
        planState: outcome.planState,
        plan: outcome.plan
      });
    }
    return {
      ...base,
      status: base.toolPermissionContext.mode === "plan" ? "planning" : "idle_input",
      pendingInteraction: null
    };
  }

  private async persistSession(session: KernelSession): Promise<void> {
    await this.sessionStore?.saveKernelCheckpoint(session);
  }

  private requireWorkflowEngine(): WorkflowEngine {
    if (!this.workflowEngine) throw new Error("ExecutionCoordinator is missing a WorkflowEngine");
    return this.workflowEngine;
  }
}

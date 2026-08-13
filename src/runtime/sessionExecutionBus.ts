import type { AgentTeamConfig, ExecutionKind, WorkflowConfig } from "../config/schema.js";
import type {
  PlanWorkflowTransitionInput,
  PlanWorkflowTransitionResult,
  ExecutionCoordinator
} from "./executionCoordinator.js";
import type { ModelContentPart, ModelMessage, ModelProvider } from "../providers/types.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import type { PermissionDecision } from "../harness/permissionController.js";
import type { SessionStore } from "../storage/sessionStore.js";
import type { WorkflowRunDossier } from "../workflow/dossier.js";
import type { WorkflowSession } from "../workflow/session.js";
import type { WorkflowState } from "../workflow/state.js";
import {
  renderTaskSummary,
  requestDispatchDirective,
  type DispatcherClarificationReason,
  type DispatcherPhase,
  type DispatcherSelection
} from "./busDispatcher.js";
import type {
  BusEvent,
  BusIntent,
  BusTaskState,
  BusTurnResult,
  SessionBusCheckpoint,
  DispatchDirective,
  TaskSummary
} from "./busTypes.js";
import { TurnEngine } from "./turnEngine.js";
import { workflowDossierContext } from "../team/handoff.js";
import { createHash } from "node:crypto";

export type SessionExecutionBusOptions = {
  config: AgentTeamConfig;
  workflowId: string;
  executionKind?: ExecutionKind;
  coordinator: ExecutionCoordinator;
  providerFactory: (providerId: string) => ModelProvider;
  cwd: string;
  sessionId: string;
  sessionStore?: SessionStore;
  permissionMode?: Exclude<PermissionMode, "plan">;
  messages?: ModelMessage[];
  checkpoint?: SessionBusCheckpoint;
  turnEngine?: TurnEngine;
  eventSink?: (event: BusEvent) => void | Promise<void>;
};

export type BusPlanApprovalInput = Omit<
  PlanWorkflowTransitionInput,
  "config" | "workflowId" | "startNodeId"
>;

export type BusPlanApprovalResult = {
  transition?: PlanWorkflowTransitionResult;
  turn: BusTurnResult;
};

type ApplyContext = {
  phase: DispatcherPhase;
  originalInput?: unknown;
  dossier?: WorkflowRunDossier;
};

export class SessionExecutionBus {
  private taskState: BusTaskState;
  private activeWorkflow?: WorkflowSession;
  private workflowUnsubscribe?: () => void;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private persistenceQueue: Promise<unknown> = Promise.resolve();
  private activeRoutingAbortController?: AbortController;
  private processedBoundaryKey?: string;
  private permissionMode?: Exclude<PermissionMode, "plan">;
  private readonly listeners = new Set<(event: BusEvent) => void | Promise<void>>();

  constructor(private readonly options: SessionExecutionBusOptions) {
    const executionKind = options.executionKind ?? "workflow";
    const workflow = executionCollection(options.config, options.workflowId, executionKind);
    if (!workflow) throw new Error(`Unknown ${executionKind} ${options.workflowId}`);
    if (!options.config.dispatcher) throw new Error("Missing required dispatcher configuration");
    const checkpoint = options.checkpoint;
    if (
      checkpoint
      && (checkpoint.session_id !== options.sessionId
        || checkpoint.workflow_id !== options.workflowId
        || (checkpoint.execution_kind ?? "workflow") !== executionKind)
    ) {
      throw new Error(`Bus checkpoint does not belong to session ${options.sessionId} workflow ${options.workflowId}`);
    }
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    this.permissionMode = options.permissionMode;
    this.taskState = checkpoint
      ? {
          ...checkpoint,
          selected_node_id: checkpoint.selected_node_id && nodeIds.has(checkpoint.selected_node_id)
            ? checkpoint.selected_node_id
            : undefined,
          current_node_id: checkpoint.current_node_id && nodeIds.has(checkpoint.current_node_id)
            ? checkpoint.current_node_id
            : undefined,
          messages: options.messages?.map(copyMessage) ?? []
        }
      : {
          session_id: options.sessionId,
          workflow_id: options.workflowId,
          execution_kind: executionKind,
          status: "idle",
          revision: 0,
          rework_cycles: 0,
          stagnant_cycles: 0,
          user_input_revision: 0,
          messages: options.messages?.map(copyMessage) ?? []
        };
  }

  get state(): BusTaskState {
    return copyState(this.taskState);
  }

  get workflow(): WorkflowSession | undefined {
    return this.activeWorkflow;
  }

  subscribe(listener: (event: BusEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPermissionMode(permissionMode?: Exclude<PermissionMode, "plan">): void {
    this.permissionMode = permissionMode;
  }

  handle(intent: BusIntent): Promise<BusTurnResult> {
    if (intent.type === "user_message") {
      return this.handleUserMessage(intent.input, { planMode: intent.planMode });
    }
    return this.enqueue(() => this.routeBoundary(intent.dossier));
  }

  handleUserMessage(input: unknown, options: { planMode?: boolean } = {}): Promise<BusTurnResult> {
    return this.enqueue(async () => {
      const message = userMessage(input);
      this.updateState({
        status: "routing",
        messages: [...this.taskState.messages, message],
        user_input_revision: (this.taskState.user_input_revision ?? 0) + 1,
        stagnant_cycles: 0,
        last_progress_fingerprint: undefined
      });
      await this.options.sessionStore?.appendBusTranscript(
        this.options.sessionId,
        message,
        this.activeWorkflow?.runId
      );
      const boundarySession = !options.planMode && this.activeWorkflow?.state.status === "awaiting_bus"
        ? this.activeWorkflow
        : undefined;
      const dossier = boundarySession
        ? await this.loadBoundaryDossier(boundarySession)
        : undefined;
      const phase: DispatcherPhase = options.planMode ? "plan" : dossier ? "lifecycle" : "user";
      const selection = await this.requestDirective(phase, dossier);
      return this.applySelection(selection, { phase, originalInput: input, dossier });
    });
  }

  approvePlan(input: BusPlanApprovalInput): Promise<BusPlanApprovalResult> {
    return this.enqueue(async () => {
      const selectedNodeId = this.taskState.selected_node_id;
      if (!selectedNodeId) {
        return {
          turn: await this.failRouting(
            "计划已批准，但母线没有可用的节点选择。请重新提交计划请求。",
            "protocol"
          )
        };
      }
      const currentWorkflow = this.activeWorkflow;
      let transition: PlanWorkflowTransitionResult;
      if (currentWorkflow) {
        const fromNodeId = currentWorkflow.state.current_node_id;
        transition = await this.options.coordinator.resolvePlanApprovalAndDispatch({
          ...input,
          config: this.options.config,
          workflowId: this.options.workflowId,
          ...(this.options.executionKind ? { executionKind: this.options.executionKind } : {}),
          workflow: currentWorkflow,
          startNodeId: selectedNodeId,
          reason: "Approved Plan Mode handoff"
        });
        this.adoptWorkflow(currentWorkflow, selectedNodeId);
        await this.emit({
          type: "bus_workflow_reassigned",
          session_id: this.options.sessionId,
          workflow_id: this.options.workflowId,
          run_id: currentWorkflow.runId,
          ...(fromNodeId ? { from_node_id: fromNodeId } : {}),
          to_node_id: selectedNodeId,
          reason: "Approved Plan Mode handoff"
        });
      } else {
        transition = await this.options.coordinator.resolvePlanApprovalAndStart({
          ...input,
          config: this.options.config,
          workflowId: this.options.workflowId,
          ...(this.options.executionKind ? { executionKind: this.options.executionKind } : {}),
          startNodeId: selectedNodeId
        });
        await this.options.sessionStore?.attachRun(this.options.sessionId, transition.workflow.runId);
        this.adoptWorkflow(transition.workflow, selectedNodeId);
        await this.emit({
          type: "bus_workflow_started",
          session_id: this.options.sessionId,
          workflow_id: this.options.workflowId,
          run_id: transition.workflow.runId,
          node_id: selectedNodeId
        });
      }
      await this.options.sessionStore?.saveKernelCheckpoint(transition.resolution.session);
      const directive: DispatchDirective = {
        type: "dispatch",
        confidence: 1,
        node_id: selectedNodeId,
        instruction: "Execute the approved plan.",
        reason: "Approved Plan Mode handoff"
      };
      this.updateState({ status: "running_workflow", last_directive: directive });
      return { transition, turn: { state: this.state, directive, workflow: transition.workflow } };
    });
  }

  adoptWorkflow(session: WorkflowSession, selectedNodeId = session.state.current_node_id): void {
    if (
      this.activeWorkflow
      && this.activeWorkflow.runId !== session.runId
      && !isTerminalWorkflowState(this.activeWorkflow.state)
    ) {
      throw new Error(`Session ${this.options.sessionId} already has active workflow ${this.activeWorkflow.runId}`);
    }
    this.workflowUnsubscribe?.();
    this.activeWorkflow = session;
    this.processedBoundaryKey = undefined;
    this.workflowUnsubscribe = session.subscribeState((state) => this.onWorkflowState(session, state));
    this.updateState({
      status: busStatusFromWorkflow(session.state),
      active_run_id: session.runId,
      current_node_id: session.state.current_node_id,
      selected_node_id: selectedNodeId ?? this.taskState.selected_node_id,
      rework_cycles: session.state.rework_count ?? 0
    });
    if (session.state.status === "awaiting_bus") this.onWorkflowState(session, session.state);
    void session.result
      .then(async (state) => {
        this.onWorkflowState(session, state);
        if (state.status === "completed") {
          await this.options.sessionStore?.syncWorkflowRunStatus(
            this.options.sessionId,
            session.runId,
            "completed"
          );
        }
      })
      .catch((error) => {
        this.updateState({ status: "failed" });
        void this.emit({
          type: "bus_failed",
          session_id: this.options.sessionId,
          workflow_id: this.options.workflowId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  resolvePermission(requestId: string, decision: PermissionDecision): void {
    const workflow = this.activeWorkflow;
    if (!workflow) throw new Error(`Session ${this.options.sessionId} has no active workflow`);
    workflow.permissions.resolve(requestId, decision);
  }

  interrupt(): Promise<void> {
    this.activeRoutingAbortController?.abort(new Error("Session execution bus interrupted"));
    return this.enqueue(async () => {
      await this.activeWorkflow?.interrupt();
      this.updateState({
        status: "waiting_user",
        current_node_id: this.activeWorkflow?.state.current_node_id
      });
    });
  }

  dispose(): void {
    this.activeRoutingAbortController?.abort(new Error("Session execution bus disposed"));
    this.activeRoutingAbortController = undefined;
    this.workflowUnsubscribe?.();
    this.workflowUnsubscribe = undefined;
    this.listeners.clear();
  }

  private async requestDirective(phase: DispatcherPhase, dossier?: WorkflowRunDossier): Promise<DispatcherSelection> {
    const controller = new AbortController();
    const snapshot = copyState(this.taskState);
    const { messages: _messages, ...busState } = snapshot;
    const workflowState = this.activeWorkflow?.state;
    const latestAttempt = workflowState?.attempts.at(-1);
    this.activeRoutingAbortController = controller;
    try {
      return await requestDispatchDirective({
        config: this.options.config,
        workflowId: this.options.workflowId,
        executionKind: this.options.executionKind,
        sessionId: this.options.sessionId,
        runId: this.activeWorkflow?.runId,
        phase,
        messages: this.taskState.messages,
        dossier,
        providerFactory: this.options.providerFactory,
        turnEngine: this.options.turnEngine,
        signal: controller.signal,
        sessionStore: this.options.sessionStore,
        eventSink: (event) => this.emit(event),
        runtimeContext: {
          bus: busState,
          ...(workflowState && this.activeWorkflow
            ? {
                workflow: {
                  run_id: this.activeWorkflow.runId,
                  status: workflowState.status,
                  current_node_id: workflowState.current_node_id,
                  rework_count: workflowState.rework_count ?? 0,
                  pending_interaction: workflowState.pending_interaction,
                  latest_attempt: latestAttempt,
                  final_summary: workflowState.final_summary
                }
              }
            : {})
        }
      });
    } finally {
      if (this.activeRoutingAbortController === controller) this.activeRoutingAbortController = undefined;
    }
  }

  private async applySelection(selection: DispatcherSelection, context: ApplyContext): Promise<BusTurnResult> {
    let directive = selection.directive;
    if (directive.type === "routing_failed") {
      await this.emitDirectiveSelected(selection, directive);
      return this.failRouting(directive.message, directive.error_kind, directive, selection.routingId, selection.responseShape);
    }
    if (context.phase === "lifecycle" && (directive.type === "answer" || directive.type === "plan")) {
      return this.failInvalidDirective(selection, "生命周期阶段返回了不允许的决策。");
    }
    if (context.phase === "user" && directive.type === "plan") {
      directive = {
        type: "dispatch",
        confidence: directive.confidence,
        node_id: directive.node_id,
        instruction: directive.reason,
        reason: directive.reason
      };
    }
    if (context.phase === "plan" && directive.type === "dispatch") {
      directive = {
        type: "plan",
        confidence: directive.confidence,
        node_id: directive.node_id,
        reason: directive.reason
      };
    }
    if (context.phase === "plan" && directive.type === "finalize") {
      return this.failInvalidDirective(selection, "计划阶段不能结束任务。");
    }
    if (context.phase === "user" && directive.type === "finalize") {
      return this.failInvalidDirective(selection, "普通用户阶段不能提前结束工作流。");
    }
    if ((directive.type === "plan" || directive.type === "dispatch") && !this.hasNode(directive.node_id)) {
      return this.failInvalidDirective(selection, `调度模型选择了不存在的节点 ${directive.node_id}。`);
    }

    this.updateState({ last_directive: directive, last_routing_error: undefined });
    await this.emitDirectiveSelected(selection, directive);

    if (directive.type === "answer") {
      await this.appendAssistant(directive.message);
      this.updateState({ status: this.passiveStatus(context.phase) });
      return { state: this.state, directive, workflow: this.activeWorkflow };
    }
    if (directive.type === "clarify") {
      return this.clarify(
        directive.message,
        selection.clarificationReason ?? "material_ambiguity",
        directive
      );
    }
    if (directive.type === "plan") {
      this.updateState({
        status: "planning",
        selected_node_id: directive.node_id
      });
      await this.emit({
        type: "bus_plan_node_selected",
        session_id: this.options.sessionId,
        workflow_id: this.options.workflowId,
        node_id: directive.node_id,
        reason: directive.reason
      });
      return { state: this.state, directive, workflow: this.activeWorkflow };
    }
    if (directive.type === "finalize") {
      const unsupported = context.dossier ? unsupportedFinalizationEvidence(context.dossier) : "缺少运行档案";
      if (unsupported) return this.failInvalidDirective(selection, `无法完成任务：${unsupported}`);
      return this.finalizeTask(directive);
    }
    if (context.phase === "lifecycle" && context.dossier) {
      const fingerprint = progressFingerprint(context.dossier, directive);
      const stagnantCycles = this.taskState.last_progress_fingerprint === fingerprint ? (this.taskState.stagnant_cycles ?? 0) + 1 : 0;
      if (stagnantCycles >= 2) return this.stallWorkflow(fingerprint, stagnantCycles);
      this.updateState({ last_progress_fingerprint: fingerprint, stagnant_cycles: stagnantCycles });
    }
    return this.dispatchWorkflow(directive, context);
  }

  private async dispatchWorkflow(directive: Extract<DispatchDirective, { type: "dispatch" }>, context: ApplyContext): Promise<BusTurnResult> {
    const images = imagePartsFromInput(context.originalInput);
    const workflowInput = {
      request: directive.instruction,
      ...(context.originalInput !== undefined ? { user_input: context.originalInput } : {}),
      ...(images.length ? { images } : {}),
      ...(context.dossier ? workflowDossierContext(context.dossier) : {})
    };
    const session = this.activeWorkflow;
    try {
      if (!session) {
        const started = await this.options.coordinator.startInteractive(
          this.options.config,
          this.options.workflowId,
          workflowInput,
          {
            permissionMode: this.permissionMode,
            sessionId: this.options.sessionId,
            startNodeId: directive.node_id,
            ...(directive.destructive_policy ? { destructivePolicy: directive.destructive_policy } : {}),
            ...(this.options.executionKind ? { executionKind: this.options.executionKind } : {})
          }
        );
        await this.options.sessionStore?.attachRun(this.options.sessionId, started.runId);
        this.adoptWorkflow(started, directive.node_id);
        this.updateState({ status: "running_workflow" });
        await this.emit({
          type: "bus_workflow_started",
          session_id: this.options.sessionId,
          workflow_id: this.options.workflowId,
          run_id: started.runId,
          node_id: directive.node_id
        });
        return { state: this.state, directive, workflow: started };
      }

      const fromNodeId = session.state.current_node_id;
      const sameRunningNode = session.state.status === "running" && fromNodeId === directive.node_id;
      if (sameRunningNode && session.queueUserInput) {
        const receipt = await session.queueUserInput(workflowInput);
        if (receipt.disposition === "active_turn") {
          this.updateState({ status: "running_workflow", current_node_id: directive.node_id });
          return { state: this.state, directive, workflow: session };
        }
      }
      if (
        fromNodeId === directive.node_id
        && (session.state.status === "waiting_user" || session.state.status === "paused")
      ) {
        await session.resumeWithUserInput(workflowInput);
      } else {
        const countsAsRework = context.phase === "lifecycle"
          && session.state.attempts.some((attempt) => attempt.node_id === directive.node_id);
        await session.dispatchToNode(directive.node_id, workflowInput, {
          reason: directive.reason,
          countsAsRework,
          ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
          ...(directive.destructive_policy ? { destructivePolicy: directive.destructive_policy } : {})
        });
      }
      this.updateState({
        status: "running_workflow",
        current_node_id: directive.node_id,
        selected_node_id: directive.node_id,
        rework_cycles: session.state.rework_count ?? this.taskState.rework_cycles,
        summary: undefined
      });
      await this.emit({
        type: "bus_workflow_reassigned",
        session_id: this.options.sessionId,
        workflow_id: this.options.workflowId,
        run_id: session.runId,
        ...(fromNodeId ? { from_node_id: fromNodeId } : {}),
        to_node_id: directive.node_id,
        reason: directive.reason
      });
      return { state: this.state, directive, workflow: session };
    } catch (error) {
      const reworkLimit = error instanceof Error && error.message.includes("rework limit");
      if (reworkLimit) {
        return this.clarify("工作流已达到返工上限。请确认是否继续返工，并明确目标节点。", "rework_limit");
      }
      return this.failRouting(
        `节点分发失败：${error instanceof Error ? error.message : String(error)}。请重试本次请求。`,
        "provider"
      );
    }
  }

  private async finalizeTask(directive: Extract<DispatchDirective, { type: "finalize" }>): Promise<BusTurnResult> {
    const session = this.activeWorkflow;
    if (!session) {
      return this.failRouting("当前没有可结束的活动工作流。请重试本次请求。", "protocol");
    }
    const document = renderTaskSummary(directive.summary);
    await session.finalize(document);
    await this.appendAssistant(document);
    this.updateState({
      status: "finalized",
      summary: directive.summary,
      active_run_id: session.runId,
      current_node_id: session.state.current_node_id
    });
    await this.emit({
      type: "bus_task_finalized",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      run_id: session.runId,
      summary: directive.summary
    });
    return { state: this.state, directive, workflow: session };
  }

  private async failInvalidDirective(
    selection: DispatcherSelection,
    message: string
  ): Promise<BusTurnResult> {
    const directive: DispatchDirective = { type: "routing_failed", confidence: 0, message, error_kind: "protocol" };
    await this.emitDirectiveSelected(selection, directive);
    return this.failRouting(message, "protocol", directive, selection.routingId);
  }

  private async stallWorkflow(fingerprint: string, stagnantCycles: number): Promise<BusTurnResult> {
    const message = "工作流连续两次没有产生新的工作区版本或运行时证据，已暂停以避免重复消耗。请提供新的约束或明确下一步。";
    const directive: DispatchDirective = { type: "clarify", confidence: 1, message };
    this.updateState({ status: "stalled", stagnant_cycles: stagnantCycles, last_progress_fingerprint: fingerprint, last_directive: directive });
    if (this.activeWorkflow) {
      await this.emit({ type: "bus_stalled", session_id: this.options.sessionId, workflow_id: this.options.workflowId, run_id: this.activeWorkflow.runId, fingerprint, stagnant_cycles: stagnantCycles, message });
    }
    await this.appendAssistant(message);
    return { state: this.state, directive, workflow: this.activeWorkflow };
  }

  private async failRouting(
    message: string,
    errorKind: "protocol" | "provider" | "configuration",
    directive: Extract<DispatchDirective, { type: "routing_failed" }> = {
      type: "routing_failed",
      confidence: 0,
      message,
      error_kind: errorKind
    },
    routingId = "runtime",
    responseShape?: string
  ): Promise<BusTurnResult> {
    this.updateState({
      status: "routing_failed",
      last_directive: directive,
      last_routing_error: { error_kind: errorKind, message }
    });
    await this.emit({
      type: "bus_routing_failed",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      routing_id: routingId,
      error_kind: errorKind,
      error: message,
      ...(responseShape ? { response_shape: responseShape } : {})
    });
    return { state: this.state, directive, workflow: this.activeWorkflow };
  }

  private async clarify(
    message: string,
    reason: DispatcherClarificationReason | "rework_limit",
    directive: DispatchDirective = { type: "clarify", confidence: 0, message }
  ): Promise<BusTurnResult> {
    await this.appendAssistant(message);
    this.updateState({ status: "waiting_user", last_directive: directive });
    await this.emit({
      type: "bus_clarification_requested",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      content: message,
      reason
    });
    return { state: this.state, directive, workflow: this.activeWorkflow };
  }

  private async routeBoundary(dossier: WorkflowRunDossier): Promise<BusTurnResult> {
    const selection = await this.requestDirective("lifecycle", dossier);
    return this.applySelection(selection, { phase: "lifecycle", dossier });
  }

  private onWorkflowState(session: WorkflowSession, workflowState: WorkflowState): void {
    if (this.activeWorkflow?.runId !== session.runId) return;
    this.updateState({
      status: busStatusFromWorkflow(workflowState),
      active_run_id: session.runId,
      current_node_id: workflowState.current_node_id,
      rework_cycles: workflowState.rework_count ?? 0
    });
    if (workflowState.status === "completed") {
      void this.options.sessionStore?.syncWorkflowRunStatus(
        this.options.sessionId,
        session.runId,
        "completed"
      );
    }
    if (workflowState.status !== "awaiting_bus") return;
    void this.emit({
      type: "bus_workflow_awaiting",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      run_id: session.runId,
      node_id: workflowState.current_node_id
    });
    const key = boundaryKey(session.runId, workflowState);
    if (this.processedBoundaryKey === key) return;
    this.processedBoundaryKey = key;
    void this.enqueue(async () => {
      if (this.activeWorkflow?.runId !== session.runId || session.state.status !== "awaiting_bus") {
        return {
          state: this.state,
          directive: this.taskState.last_directive ?? {
            type: "clarify",
            confidence: 0,
            message: "Workflow boundary changed before routing."
          }
        };
      }
      const dossier = await this.loadBoundaryDossier(session);
      if (!dossier) {
        return {
          state: this.state,
          directive: this.taskState.last_directive ?? {
            type: "clarify",
            confidence: 0,
            message: "Workflow boundary changed before routing."
          }
        };
      }
      return this.routeBoundary(dossier);
    }).catch((error) => {
      this.updateState({ status: "failed" });
      void this.emit({
        type: "bus_failed",
        session_id: this.options.sessionId,
        workflow_id: this.options.workflowId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async loadBoundaryDossier(session: WorkflowSession): Promise<WorkflowRunDossier | undefined> {
    const boundary = await session.waitForBoundary();
    if (
      this.activeWorkflow?.runId !== session.runId
      || boundary.status !== "awaiting_bus"
      || session.state.status !== "awaiting_bus"
    ) {
      return undefined;
    }
    return this.options.coordinator.dossier(session.runId);
  }

  private passiveStatus(phase: DispatcherPhase): BusTaskState["status"] {
    if (phase === "plan") return "planning";
    if (!this.activeWorkflow) return "idle";
    return busStatusFromWorkflow(this.activeWorkflow.state);
  }

  private hasNode(nodeId: string): boolean {
    return executionCollection(this.options.config, this.options.workflowId, this.options.executionKind).nodes.some((node) => node.id === nodeId);
  }

  private async appendAssistant(content: string): Promise<void> {
    const message: ModelMessage = { role: "assistant", content };
    this.updateState({ messages: [...this.taskState.messages, message] });
    await this.options.sessionStore?.appendBusTranscript(
      this.options.sessionId,
      message,
      this.activeWorkflow?.runId
    );
    await this.emit({
      type: "bus_assistant_message",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      content
    });
  }

  private async emitDirectiveSelected(
    selection: DispatcherSelection,
    directive: DispatchDirective
  ): Promise<void> {
    await this.emit({
      type: "bus_directive_selected",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      routing_id: selection.routingId,
      phase: selection.phase,
      directive,
      ...(selection.thinking ? { thinking: selection.thinking } : {})
    });
  }

  private updateState(update: Partial<BusTaskState>): void {
    this.taskState = {
      ...this.taskState,
      ...update,
      revision: this.taskState.revision + 1,
      messages: update.messages?.map(copyMessage) ?? this.taskState.messages
    };
    if (!this.options.sessionStore) return;
    const snapshot = copyState(this.taskState);
    const { messages: _messages, ...checkpoint } = snapshot;
    this.persistenceQueue = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.options.sessionStore!.saveBusState(this.options.sessionId, checkpoint))
      .catch(async (error) => {
        this.taskState = {
          ...this.taskState,
          status: "failed",
          revision: this.taskState.revision + 1
        };
        await this.emit({
          type: "bus_failed",
          session_id: this.options.sessionId,
          workflow_id: this.options.workflowId,
          error: `Failed to persist bus state: ${error instanceof Error ? error.message : String(error)}`
        });
      });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.catch(() => undefined).then(async () => {
      const result = await task();
      await this.persistenceQueue;
      return result;
    });
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private async emit(event: BusEvent): Promise<void> {
    if (
      event.type === "bus_directive_selected"
      || event.type === "bus_dispatcher_protocol_retry_scheduled"
      || event.type === "bus_routing_failed"
    ) {
      await this.options.sessionStore?.appendBusRoutingEvent(this.options.sessionId, event);
    }
    await this.options.eventSink?.(event);
    for (const listener of this.listeners) await listener(event);
  }
}

function executionCollection(
  config: AgentTeamConfig,
  configId: string,
  executionKind: ExecutionKind = "workflow"
): WorkflowConfig {
  const collection = executionKind === "team" ? config.teams?.[configId] : config.workflows[configId];
  if (!collection) throw new Error(`Unknown ${executionKind} ${configId}`);
  return collection;
}

function userMessage(input: unknown): ModelMessage {
  if (typeof input === "string") return { role: "user", content: input, metadata: { userMessageKind: "human" } };
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    const text = typeof value.request === "string"
      ? value.request
      : typeof value.answer === "string"
        ? value.answer
        : JSON.stringify(value);
    const images = imagePartsFromInput(input);
    if (images.length) {
      return {
        role: "user",
        metadata: { userMessageKind: "human" },
        content: [{ type: "text", text }, ...images]
      };
    }
    return { role: "user", content: text, metadata: { userMessageKind: "human" } };
  }
  return {
    role: "user",
    content: input === undefined ? "" : JSON.stringify(input),
    metadata: { userMessageKind: "human" }
  };
}

function imagePartsFromInput(input: unknown): Array<Extract<ModelContentPart, { type: "image" }>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const images = (input as { images?: unknown }).images;
  return Array.isArray(images) ? images.filter(isImagePart).map((image) => ({ ...image })) : [];
}

function isImagePart(value: unknown): value is Extract<ModelContentPart, { type: "image" }> {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.type === "image"
    && (item.media_type === "image/png" || item.media_type === "image/jpeg" || item.media_type === "image/webp")
    && typeof item.data === "string";
}

function busStatusFromWorkflow(state: WorkflowState): BusTaskState["status"] {
  if (state.status === "awaiting_bus") return "awaiting_bus";
  if (state.status === "waiting_user" || state.status === "paused") return "waiting_user";
  if (state.status === "completed") return "finalized";
  if (state.status === "failed" || state.status === "cancelled") return "failed";
  return "running_workflow";
}

function isTerminalWorkflowState(state: WorkflowState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}

function boundaryKey(runId: string, state: WorkflowState): string {
  const current = state.current_node_id ?? "";
  const attempt = [...state.attempts].reverse().find((item) => item.node_id === current);
  return [
    runId,
    current,
    attempt?.attempt ?? 0,
    attempt?.activation ?? 0,
    state.rework_count ?? 0,
    state.status
  ].join(":");
}

function copyMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
    tool_calls: message.tool_calls?.map((call) => ({ ...call }))
  };
}

function copyState(state: BusTaskState): BusTaskState {
  return {
    ...state,
    messages: state.messages.map(copyMessage),
    summary: state.summary
      ? {
          ...state.summary,
          outcomes: [...state.summary.outcomes],
          verification: [...state.summary.verification],
          residual_risks: [...state.summary.residual_risks],
          artifacts: [...state.summary.artifacts]
        }
      : undefined
  };
}

function unsupportedFinalizationEvidence(dossier: WorkflowRunDossier): string | undefined {
  const latest = dossier.latest_results ?? latestDossierResults(dossier);
  if (!latest.length) return "没有节点结果";
  const invalid = latest.find((result) => result.evidence?.status !== "verified");
  if (invalid) return `节点 ${invalid.node_id} 的最新结果缺少当前激活的有效证据（${invalid.evidence?.status ?? "legacy_unverified"}）`;
  const activeProcesses = new Set<string>();
  for (const process of dossier.lifecycle.processes) {
    if (process.status === "started") activeProcesses.add(process.process_id);
    else activeProcesses.delete(process.process_id);
  }
  if (activeProcesses.size) return "仍有活动后台进程";
  return undefined;
}

function latestDossierResults(dossier: WorkflowRunDossier) {
  const latest = new Map<string, WorkflowRunDossier["node_results"][number]>();
  for (const result of dossier.node_results) {
    const previous = latest.get(result.node_id);
    if (!previous || result.seq > previous.seq) latest.set(result.node_id, result);
  }
  return [...latest.values()];
}

function progressFingerprint(dossier: WorkflowRunDossier, directive: Extract<DispatchDirective, { type: "dispatch" }>): string {
  const latest = dossier.latest_results ?? latestDossierResults(dossier);
  const material = latest.map((result) => ({ node: result.node_id, status: result.evidence?.status, workspace: result.evidence?.workspace_after_sha256, tools: result.evidence?.successful_tool_calls, artifacts: result.evidence?.artifact_count }));
  return createHash("sha256").update(JSON.stringify({ node: directive.node_id, instruction: directive.instruction.trim().replace(/\s+/g, " "), material })).digest("hex");
}

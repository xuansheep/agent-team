import type { AgentTeamConfig } from "../config/schema.js";
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

export type SessionExecutionBusOptions = {
  config: AgentTeamConfig;
  workflowId: string;
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
    const workflow = options.config.workflows[options.workflowId];
    if (!workflow) throw new Error(`Unknown workflow ${options.workflowId}`);
    if (!options.config.dispatcher) throw new Error("Missing required dispatcher configuration");
    const checkpoint = options.checkpoint;
    if (
      checkpoint
      && (checkpoint.session_id !== options.sessionId || checkpoint.workflow_id !== options.workflowId)
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
          status: "idle",
          revision: 0,
          rework_cycles: 0,
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
        messages: [...this.taskState.messages, message]
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
          turn: await this.clarify(
            "计划已批准，但母线没有可用的节点选择。请补充目标节点后重新批准。",
            "invalid_directive"
          )
        };
      }
      const currentWorkflow = this.activeWorkflow;
      let transition: PlanWorkflowTransitionResult;
      if (currentWorkflow && !isTerminalWorkflowState(currentWorkflow.state)) {
        const fromNodeId = currentWorkflow.state.current_node_id;
        transition = await this.options.coordinator.resolvePlanApprovalAndDispatch({
          ...input,
          config: this.options.config,
          workflowId: this.options.workflowId,
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
    this.activeRoutingAbortController = controller;
    try {
      return await requestDispatchDirective({
        config: this.options.config,
        workflowId: this.options.workflowId,
        sessionId: this.options.sessionId,
        runId: this.activeWorkflow?.runId,
        phase,
        messages: this.taskState.messages,
        dossier,
        providerFactory: this.options.providerFactory,
        turnEngine: this.options.turnEngine,
        signal: controller.signal,
        sessionStore: this.options.sessionStore,
        eventSink: (event) => this.emit(event)
      });
    } finally {
      if (this.activeRoutingAbortController === controller) this.activeRoutingAbortController = undefined;
    }
  }

  private async applySelection(selection: DispatcherSelection, context: ApplyContext): Promise<BusTurnResult> {
    let directive = selection.directive;
    if (context.phase === "lifecycle" && (directive.type === "answer" || directive.type === "plan")) {
      return this.clarify(
        "工作流已到达母线边界。请明确是结束任务，还是指定需要返工的节点。",
        "invalid_directive"
      );
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
      return this.clarify(
        "计划尚未批准，不能结束任务。请继续完善计划或批准后执行。",
        "invalid_directive"
      );
    }
    if (context.phase === "user" && directive.type === "finalize") {
      return this.clarify(
        "工作流尚未到达可结束的母线边界，不能提前生成最终总结。请继续执行或先中断当前节点。",
        "invalid_directive"
      );
    }
    if ((directive.type === "plan" || directive.type === "dispatch") && !this.hasNode(directive.node_id)) {
      return this.clarify(
        `调度模型选择了不存在的节点 ${directive.node_id}。请明确一个有效节点。`,
        "invalid_directive"
      );
    }

    this.updateState({ last_directive: directive });
    await this.emit({
      type: "bus_directive_selected",
      session_id: this.options.sessionId,
      workflow_id: this.options.workflowId,
      directive
    });

    if (directive.type === "answer") {
      await this.appendAssistant(directive.message);
      this.updateState({ status: this.passiveStatus(context.phase) });
      return { state: this.state, directive, workflow: this.activeWorkflow };
    }
    if (directive.type === "clarify") {
      return this.clarify(
        directive.message,
        selection.clarificationReason ?? "invalid_directive",
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
      return this.finalizeTask(directive);
    }
    return this.dispatchWorkflow(directive, context);
  }

  private async dispatchWorkflow(directive: Extract<DispatchDirective, { type: "dispatch" }>, context: ApplyContext): Promise<BusTurnResult> {
    const images = imagePartsFromInput(context.originalInput);
    const workflowInput = {
      request: directive.instruction,
      user_input: context.originalInput,
      ...(images.length ? { images } : {}),
      ...(context.dossier ? { prior_dossier: context.dossier } : {})
    };
    const session = this.activeWorkflow;
    try {
      if (!session || isTerminalWorkflowState(session.state)) {
        const started = await this.options.coordinator.startInteractive(
          this.options.config,
          this.options.workflowId,
          workflowInput,
          {
            permissionMode: this.permissionMode,
            sessionId: this.options.sessionId,
            startNodeId: directive.node_id
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
          ...(this.permissionMode ? { permissionMode: this.permissionMode } : {})
        });
      }
      this.updateState({
        status: "running_workflow",
        current_node_id: directive.node_id,
        selected_node_id: directive.node_id,
        rework_cycles: session.state.rework_count ?? this.taskState.rework_cycles
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
      return this.clarify(
        reworkLimit
          ? "工作流已达到返工上限。请确认是否继续返工，并明确目标节点。"
          : `节点分发失败：${error instanceof Error ? error.message : String(error)}。请确认目标节点后重试。`,
        reworkLimit ? "rework_limit" : "invalid_directive"
      );
    }
  }

  private async finalizeTask(directive: Extract<DispatchDirective, { type: "finalize" }>): Promise<BusTurnResult> {
    const session = this.activeWorkflow;
    if (!session) {
      return this.clarify("当前没有可结束的活动工作流。请先执行任务或直接提问。", "invalid_directive");
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
    return this.options.config.workflows[this.options.workflowId]!.nodes.some((node) => node.id === nodeId);
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
    await this.options.eventSink?.(event);
    for (const listener of this.listeners) await listener(event);
  }
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

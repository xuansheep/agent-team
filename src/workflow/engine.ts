import { createHash } from "node:crypto";
import { AgentTeamConfig, DEFAULT_MAX_REWORK_CYCLES, PermissionSet, permissionSetSchema, WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";
import { handoffHasImages } from "../harness/context.js";
import { HarnessEvent, StoredEvent } from "../harness/events.js";
import { EventStream } from "../harness/eventStream.js";
import { mergePermissions } from "../harness/permissions.js";
import { PermissionController } from "../harness/permissionController.js";
import { RuntimeInteraction, runNode, type NodeWaitingUserResult } from "../harness/runtime.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import { ModelContentPart, ModelMessage, ModelProvider } from "../providers/types.js";
import { ActiveTurnInputChannel } from "../runtime/activeTurnInput.js";
import { getProviderMaxOutputTokens, modelRegistryFromProviderConfig } from "../model/modelRegistry.js";
import { resolveEffortForWorkflowNode, resolveModelForWorkflowNode } from "../model/modelRouting.js";
import { formatRunError } from "../runtime/errorFormatting.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { RunStore, RunSummary } from "../storage/runStore.js";
import { prepareProjectStorage, type ProjectStorageContext } from "../storage/projectStorage.js";
import { buildHandoff, buildResumeHandoff, compactHandoffForModel, compactHandoffLayer, sameCanonicalHandoff } from "../team/handoff.js";
import type { PlanRequestedPermission } from "../plans/planSession.js";
import { stripInternalPlanModeHandoffMarkers } from "../plans/planSession.js";
import { NodeResult, nodeResultSchema } from "../team/nodeResult.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { SkillRuntime } from "../skills/runtime.js";
import { createLocalToolRegistry } from "../tools/registry.js";
import { CONVERSATION_INTERRUPTED_QUESTION_ID, CONVERSATION_INTERRUPTED_TEXT, WorkflowState } from "./state.js";
import { WorkflowSession, type WorkflowDispatchOptions } from "./session.js";
import { firstNodeId } from "./transitions.js";
import { NodeTransitionController } from "./nodeTransitionController.js";
import { buildWorkflowRunDossier, type WorkflowRunDossier } from "./dossier.js";
export type WorkflowEngineOptions = {
    providerFactory: (providerId: string) => ModelProvider;
    cwd: string;
    projectStorage?: ProjectStorageContext;
    runRoot?: string;
    mcpRuntime?: McpRuntime;
    skillRuntime?: SkillRuntime;
};
type ContinueOptions = {
    config: AgentTeamConfig;
    workflowId: string;
    workflow: WorkflowConfig;
    store: RunStore;
    runId: string;
    startNodeId: string;
    initialHandoff: unknown;
    attempts: WorkflowState["attempts"];
    nodeCheckpoints?: WorkflowState["node_checkpoints"];
    suspendedStack?: string[];
    reworkCount?: number;
    reworkLimit?: number;
    eventSink?: (event: StoredEvent) => void;
    interaction?: RuntimeInteraction;
    activeInputChannel?: ActiveTurnInputChannel<ModelMessage>;
    abortSignal?: AbortSignal;
    isInterrupted?: () => boolean;
    controlSignal?: () => WorkflowControlSignal | undefined;
    onState?: (state: WorkflowState) => void;
    resume?: {
        nodeId: string;
        attempt: number;
        activation?: number;
        dialogueMessages: ModelMessage[];
        dialogueCursor?: number;
        handoff?: unknown;
    };
    runPermissionMode?: WorkflowRunPermissionMode;
    planRequestedPermissionRules?: string[];
    configFingerprint?: string;
};
export type WorkflowRunPermissionMode = Exclude<PermissionMode, "plan">;
type WorkflowControlSignal = "interrupt" | "dispatch" | "finalize";
export type WorkflowRunOptions = {
    permissionMode?: WorkflowRunPermissionMode;
    clearContext?: boolean;
    sessionId?: string;
    startNodeId?: string;
};
export class WorkflowEngine {
    private readonly transitionController = new NodeTransitionController();
    private preparedProjectStorage?: Promise<ProjectStorageContext>;
    constructor(private readonly options: WorkflowEngineOptions) {
        if (options.projectStorage && options.runRoot) {
            throw new Error("WorkflowEngine options projectStorage and runRoot are mutually exclusive");
        }
    }
    createProvider(providerId: string): ModelProvider {
        return this.options.providerFactory(providerId);
    }
    private async runStore(): Promise<RunStore> {
        if (this.options.projectStorage) return new RunStore(this.options.projectStorage);
        if (this.options.runRoot) return new RunStore(this.options.runRoot);
        this.preparedProjectStorage ??= prepareProjectStorage({ cwd: this.options.cwd });
        return new RunStore(await this.preparedProjectStorage);
    }
    async run(config: AgentTeamConfig, workflowId: string, input: unknown, options: WorkflowRunOptions = {}): Promise<WorkflowState> {
        assertWorkflowRunPermissionMode(options.permissionMode);
        const workflow = config.workflows[workflowId];
        if (!workflow)
            throw new Error(`Unknown workflow ${workflowId}`);
        const startNodeId = resolveStartNodeId(workflow, options.startNodeId);
        const store = await this.runStore();
        const run = await store.createRun(workflowId, publicWorkflowInput(input), { sessionId: options.sessionId, configFingerprint: workflowConfigFingerprint(config, workflowId), permissionMode: options.permissionMode });
        const initialHandoff = await this.prepareInitialHandoff(input, run.runDir, options);
        const planRequestedPermissionRules = planRequestedPermissionRulesFromHandoff(initialHandoff);
        return this.continueFrom({
            config,
            workflowId,
            workflow,
            store,
            runId: run.runId,
            startNodeId,
            initialHandoff,
            attempts: [],
            runPermissionMode: options.permissionMode,
            planRequestedPermissionRules
        });
    }
    async resume(config: AgentTeamConfig, workflowId: string, runId: string, userInput: unknown): Promise<WorkflowState> {
        const workflow = config.workflows[workflowId];
        if (!workflow)
            throw new Error(`Unknown workflow ${workflowId}`);
        const store = await this.runStore();
        const state = await store.loadState(runId);
        const lease = await store.acquireRunLease(runId);
        try {
        const guarded = await this.continueReworkLimitWithInput({ config, workflowId, workflow, store, runId, state, input: userInput });
        if (guarded)
            return guarded;
        if (state.status === "waiting_user" || state.status === "paused") {
            if (!state.current_node_id)
                throw new Error(`Run ${runId} has no current node`);
            const resumed = await this.continueSavedCheckpointWithInput({ config, workflowId, workflow, store, runId, state, input: userInput });
            if (resumed)
                return resumed;
            const recoveredHandoff = await recoverLatestIncomingHandoff(store, runId, state, state.handoff);
            return this.continueFrom({
                config,
                workflowId,
                workflow,
                store,
                runId,
                startNodeId: state.current_node_id,
                initialHandoff: resumeHandoffWithUserInput(recoveredHandoff, userInput),
                attempts: state.attempts,
                nodeCheckpoints: state.node_checkpoints,
                suspendedStack: state.suspended_stack,
                reworkCount: state.rework_count,
                reworkLimit: state.rework_limit,
                runPermissionMode: state.run_permission_mode,
                planRequestedPermissionRules: state.plan_requested_permission_rules
            });
        }
        if (!state.resume_checkpoint)
            throw new Error(`Run ${runId} has no resume checkpoint`);
        const resumed = await this.continueSavedCheckpointWithInput({ config, workflowId, workflow, store, runId, state, input: userInput });
        if (resumed)
            return resumed;
        const recoveredHandoff = await recoverLatestIncomingHandoff(store, runId, state, state.resume_checkpoint.handoff);
        return this.continueFrom({
            config,
            workflowId,
            workflow,
            store,
            runId,
            startNodeId: state.resume_checkpoint.node_id,
            initialHandoff: resumeHandoffWithUserInput(recoveredHandoff, userInput, true),
            attempts: state.attempts,
            nodeCheckpoints: state.node_checkpoints,
            suspendedStack: state.suspended_stack,
            reworkCount: state.rework_count,
            reworkLimit: state.rework_limit,
            runPermissionMode: state.run_permission_mode,
            planRequestedPermissionRules: state.plan_requested_permission_rules
        });
        }
        finally {
            await lease.release();
        }
    }
    async listRuns(options: {
        limit?: number;
    } = {}): Promise<RunSummary[]> {
        const store = await this.runStore();
        return store.listRuns(options);
    }
    async dossier(runId: string): Promise<WorkflowRunDossier> {
        const store = await this.runStore();
        return buildWorkflowRunDossier(store, runId);
    }
    async resumeInteractive(config: AgentTeamConfig, runId: string): Promise<WorkflowSession> {
        const store = await this.runStore();
        const state = await store.loadState(runId);
        const workflowId = state.workflow_id;
        const workflow = config.workflows[workflowId];
        if (!workflow)
            throw new Error(`Unknown workflow ${workflowId}`);
        const stream = new EventStream<StoredEvent>();
        const replayEvents = await store.loadEvents(runId);
        for (const event of replayEvents) {
            stream.push(event);
        }
        const permissions = new PermissionController();
        const activeInputChannel = new ActiveTurnInputChannel<ModelMessage>();
        let interrupted = false;
        let controlRequest: WorkflowControlSignal | undefined;
        let lifecycleQueue: Promise<void> = Promise.resolve();
        let resultSettled = false;
        let activeRun: Promise<WorkflowState> | undefined;
        let activeAbortController: AbortController | undefined;
        let latestState: WorkflowState = state;
        const stateListeners = new Set<(state: WorkflowState) => void>();
        const publishState = (nextState: WorkflowState) => {
            latestState = nextState;
            for (const listener of stateListeners) listener(nextState);
        };
        const subscribeState = (listener: (state: WorkflowState) => void) => {
            stateListeners.add(listener);
            return () => stateListeners.delete(listener);
        };
        const waitForBoundary = async () => {
            const boundary = await waitForWorkflowBoundary(() => latestState, subscribeState);
            const pendingRun = activeRun;
            if (pendingRun)
                await pendingRun;
            return boundary;
        };
        let resolveResult!: (state: WorkflowState) => void;
        let rejectResult!: (error: unknown) => void;
        let result!: Promise<WorkflowState>;
        const resetResult = () => {
            resultSettled = false;
            result = new Promise<WorkflowState>((resolve, reject) => {
                resolveResult = resolve;
                rejectResult = reject;
            });
        };
        resetResult();
        const finish = (nextState: WorkflowState) => {
            publishState(nextState);
            if (!resultSettled) {
                resultSettled = true;
                resolveResult(nextState);
            }
            stream.end();
        };
        const fail = async (error: unknown) => {
            const formatted = formatRunError(error);
            const failedState: WorkflowState = { ...latestState, status: "paused" };
            publishState(failedState);
            await store.saveState(runId, failedState);
            await this.appendEvent(store, runId, { type: "run_failed", error: formatted.message, ...(formatted.detail ? { detail: formatted.detail } : {}) }, (event) => stream.push(event));
            if (!resultSettled) {
                resultSettled = true;
                rejectResult(error);
            }
            stream.end();
        };
        const finishWhenTerminal = (nextState: WorkflowState) => {
            publishState(nextState);
            if (nextState.status === "completed" || nextState.status === "cancelled" || nextState.status === "failed")
                finish(nextState);
        };
        const runSegment = async (segment: {
            startNodeId: string;
            initialHandoff: unknown;
            attempts: WorkflowState["attempts"];
            resume?: ContinueOptions["resume"];
        }) => {
            if (activeRun)
                throw new Error(`Run ${runId} is already active`);
            const abortController = new AbortController();
            activeAbortController = abortController;
            activeRun = this.continueFrom({
                config,
                workflowId,
                workflow,
                store,
                runId,
                startNodeId: segment.startNodeId,
                initialHandoff: segment.initialHandoff,
                attempts: segment.attempts,
                nodeCheckpoints: latestState.node_checkpoints,
                suspendedStack: latestState.suspended_stack,
                reworkCount: latestState.rework_count,
                reworkLimit: latestState.rework_limit,
                resume: segment.resume,
                runPermissionMode: latestState.run_permission_mode,
                planRequestedPermissionRules: latestState.plan_requested_permission_rules,
                eventSink: (event) => stream.push(event),
                interaction: {
                    requestPermission: (request) => permissions.request(request)
                },
                activeInputChannel,
                abortSignal: abortController.signal,
                isInterrupted: () => interrupted,
                controlSignal: () => controlRequest,
                onState: publishState
            });
            try {
                const nextState = await activeRun;
                finishWhenTerminal(nextState);
                return nextState;
            }
            finally {
                if (activeAbortController === abortController)
                    activeAbortController = undefined;
                activeRun = undefined;
            }
        };
        const interruptRun = async () => {
            if ((resultSettled && !activeRun) || interrupted)
                return;
            interrupted = true;
            controlRequest = "interrupt";
            permissions.resolveAll("deny_once");
            activeAbortController?.abort();
            if (activeRun) {
                publishState(await activeRun);
                return;
            }
            const waitingState = await this.pauseStateForUser({
                store,
                runId,
                workflowId,
                latestState,
                eventSink: (event) => stream.push(event)
            });
            publishState(waitingState);
        };
        if (state.status === "running") {
            queueMicrotask(() => {
                void interruptRun().catch((error) => {
                    void fail(error);
                });
            });
        }
        else if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") {
            queueMicrotask(() => finish(state));
        }
        const withRunLease = async (task: () => Promise<void>): Promise<void> => {
            const lease = await store.acquireRunLease(runId);
            try {
                await task();
            }
            finally {
                await lease.release();
            }
        };
        const enqueueLifecycle = (task: () => Promise<void>): Promise<void> => {
            const queued = lifecycleQueue.catch(() => undefined).then(task);
            lifecycleQueue = queued.catch(() => undefined);
            return queued;
        };
        const dispatchToNode = (nodeId: string, input: unknown, dispatchOptions: WorkflowDispatchOptions = {}) => enqueueLifecycle(() => withRunLease(async () => {
            const continuingTerminal = latestState.status === "completed"
                || latestState.status === "cancelled"
                || latestState.status === "failed";
            if (resultSettled) resetResult();
            if (continuingTerminal) {
                stream.reopen();
                const continuedState: WorkflowState = {
                    ...latestState,
                    status: "pending",
                    pending_interaction: undefined,
                    final_summary: undefined
                };
                publishState(continuedState);
                await store.saveState(runId, continuedState);
                await this.appendEvent(store, runId, {
                    type: "run_continued",
                    workflow_id: workflowId,
                    input: publicWorkflowInput(input)
                }, (event) => stream.push(event));
            }
            resolveStartNodeId(workflow, nodeId);
            const fromNodeId = latestState.current_node_id;
            if (activeRun) {
                controlRequest = "dispatch";
                interrupted = false;
                permissions.resolveAll("deny_once");
                activeAbortController?.abort();
                await activeRun;
            }
            controlRequest = undefined;
            interrupted = false;
            const preparedInput = await this.prepareInitialHandoff(input, store.runDir(runId));
            const handoff = busDispatchHandoff(latestState.handoff, preparedInput, fromNodeId, nodeId, dispatchOptions.reason);
            const dispatchState = workflowDispatchState(latestState, workflow, nodeId, handoff, dispatchOptions);
            publishState(dispatchState);
            await store.saveState(runId, dispatchState);
            stream.reopen();
            await this.appendEvent(store, runId, {
                type: "bus_node_dispatched",
                ...(fromNodeId ? { from_node_id: fromNodeId } : {}),
                to_node_id: nodeId,
                ...(dispatchOptions.reason ? { reason: dispatchOptions.reason } : {})
            }, (event) => stream.push(event));
            void runSegment({ startNodeId: nodeId, initialHandoff: handoff, attempts: latestState.attempts }).catch((error) => {
                void fail(error);
            });
        }));
        const finalize = (summary: string) => enqueueLifecycle(() => withRunLease(async () => {
            const document = summary.trim();
            if (!document) throw new Error("Task summary must not be empty");
            if (resultSettled) {
                if (latestState.status === "completed") return;
                throw new Error(`Run ${runId} is already settled`);
            }
            if (activeRun) {
                controlRequest = "finalize";
                interrupted = false;
                permissions.resolveAll("deny_once");
                activeAbortController?.abort();
                await activeRun;
            }
            controlRequest = undefined;
            interrupted = false;
            const artifact = await new ArtifactStore(store.runDir(runId)).writeText("bus", "final-summary.md", `${document}\n`, {
                description: "Workflow bus final summary",
                attempt: 1,
                activation: 1
            });
            await this.appendEvent(store, runId, { type: "artifact_created", node_id: "bus", artifact_id: artifact.artifactId, path: artifact.path }, (event) => stream.push(event));
            await this.appendEvent(store, runId, { type: "complete_summary_available", node_id: "bus", attempt: 1, activation: 1, document }, (event) => stream.push(event));
            const finalState: WorkflowState = {
                ...latestState,
                status: "completed",
                pending_interaction: undefined,
                final_summary: document
            };
            publishState(finalState);
            await store.saveState(runId, finalState);
            await this.appendEvent(store, runId, {
                type: "run_completed",
                result: {
                    status: finalState.status,
                    workflow_id: finalState.workflow_id,
                    summary: document,
                    artifact_id: artifact.artifactId
                }
            }, (event) => stream.push(event));
            finish(finalState);
        }));
        const session: WorkflowSession = {
            sessionId: (await store.metadata(runId)).sessionId,
            runId,
            get state() { return latestState; },
            events: stream,
            replayEventCount: replayEvents.length,
            permissions,
            interrupt: interruptRun,
            resumeWithUserInput: (input) => withRunLease(async () => {
                if (activeRun)
                    await activeRun;
                if (latestState.status !== "waiting_user" && latestState.status !== "paused")
                    throw new Error(`Run ${runId} is not waiting for user input`);
                if (resultSettled) resetResult();
                if (!latestState.current_node_id)
                    throw new Error(`Run ${runId} has no current node`);
                interrupted = false;
                controlRequest = undefined;
                stream.reopen();
                const guarded = resolveReworkLimitInput(latestState, workflow, input);
                if (guarded) {
                    publishState(guarded.state);
                    await store.saveState(runId, guarded.state);
                    if (guarded.type === "cancel") {
                        await this.appendEvent(store, runId, { type: "run_cancelled", reason: "用户在返工上限处终止工作流" }, (event) => stream.push(event));
                        finishWhenTerminal(guarded.state);
                        return;
                    }
                    await this.appendEvent(store, runId, { type: "transition", from: guarded.fromNodeId, to: guarded.targetNodeId, reason: "backward", activation: guarded.activation }, (event) => stream.push(event));
                    const nextState = await runSegment({ startNodeId: guarded.targetNodeId, initialHandoff: guarded.handoff, attempts: guarded.state.attempts, resume: guarded.resume });
                    finishWhenTerminal(nextState);
                    return;
                }
                const checkpointResume = resumeFromCheckpoint(latestState, input);
                if (checkpointResume) {
                    await recoverCheckpointResumeHandoff(store, runId, latestState, checkpointResume);
                    await this.persistCheckpointResume(store, runId, checkpointResume, (event) => stream.push(event));
                    const nextState = await runSegment({
                        startNodeId: checkpointResume.nodeId,
                        initialHandoff: checkpointResume.handoff,
                        attempts: latestState.attempts,
                        resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, activation: checkpointResume.activation, handoff: checkpointResume.handoff, dialogueMessages: checkpointResume.dialogueMessages, dialogueCursor: checkpointResume.dialogueCursor }
                    });
                    finishWhenTerminal(nextState);
                    return;
                }
                await this.appendEvent(store, runId, {
                    type: "user_message",
                    text: userMessageText(input),
                    node_id: latestState.current_node_id,
                    attempt: latestState.attempts.filter((attempt) => attempt.node_id === latestState.current_node_id).length + 1
                }, (event) => stream.push(event));
                const recoveredHandoff = await recoverLatestIncomingHandoff(store, runId, latestState, latestState.handoff);
                const nextState = await runSegment({
                    startNodeId: latestState.current_node_id,
                    initialHandoff: resumeHandoffWithUserInput(recoveredHandoff, input),
                    attempts: latestState.attempts
                });
                finishWhenTerminal(nextState);
            }),
            queueUserInput: async (input, inputId) => activeInputChannel.offer(userInputModelMessage(input), inputId),
            continueWithInput: (input) => {
                stream.reopen();
                return withRunLease(async () => {
                    if (activeRun)
                        await activeRun;
                    if (latestState.status === "running" || latestState.status === "waiting_user" || latestState.status === "paused") {
                        throw new Error(`Run ${runId} is not paused`);
                    }
                    const continuingTerminal = latestState.status === "completed"
                        || latestState.status === "cancelled"
                        || latestState.status === "failed";
                    if (resultSettled) resetResult();
                    if (continuingTerminal) {
                        const continuedState: WorkflowState = {
                            ...latestState,
                            status: "pending",
                            pending_interaction: undefined,
                            final_summary: undefined
                        };
                        publishState(continuedState);
                        await store.saveState(runId, continuedState);
                        await this.appendEvent(store, runId, {
                            type: "run_continued",
                            workflow_id: workflowId,
                            input: publicWorkflowInput(input)
                        }, (event) => stream.push(event));
                    }
                    interrupted = false;
                    controlRequest = undefined;
                    if (latestState.resume_checkpoint) {
                        const checkpointResume = resumeFromCheckpoint(latestState, input);
                        if (checkpointResume) {
                            await recoverCheckpointResumeHandoff(store, runId, latestState, checkpointResume);
                            await this.persistCheckpointResume(store, runId, checkpointResume, (event) => stream.push(event));
                            const nextState = await runSegment({
                                startNodeId: checkpointResume.nodeId,
                                initialHandoff: checkpointResume.handoff,
                                attempts: latestState.attempts,
                                resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, activation: checkpointResume.activation, handoff: checkpointResume.handoff, dialogueMessages: checkpointResume.dialogueMessages, dialogueCursor: checkpointResume.dialogueCursor }
                            });
                            finishWhenTerminal(nextState);
                            return;
                        }
                        const checkpoint = latestState.resume_checkpoint;
                        await this.appendEvent(store, runId, {
                            type: "user_message",
                            text: userMessageText(input),
                            node_id: checkpoint.node_id,
                            attempt: latestState.attempts.filter((attempt) => attempt.node_id === checkpoint.node_id).length + 1
                        }, (event) => stream.push(event));
                        const recoveredHandoff = await recoverLatestIncomingHandoff(store, runId, latestState, checkpoint.handoff);
                        const nextState = await runSegment({
                            startNodeId: checkpoint.node_id,
                            initialHandoff: resumeHandoffWithUserInput(recoveredHandoff, input, true),
                            attempts: latestState.attempts
                        });
                        finishWhenTerminal(nextState);
                        return;
                    }
                    const initialHandoff = await this.prepareInitialHandoff(input, store.runDir(runId));
                    const nextState = await runSegment({
                        startNodeId: firstNodeId(workflow),
                        initialHandoff,
                        attempts: latestState.attempts
                    });
                    finishWhenTerminal(nextState);
                });
            },
            dispatchToNode,
            finalize,
            subscribeState,
            waitForBoundary,
            get result() { return result; },
            set result(value: Promise<WorkflowState>) { result = value; }
        };
        return session;
    }
    async startInteractive(config: AgentTeamConfig, workflowId: string, input: unknown, options: WorkflowRunOptions = {}): Promise<WorkflowSession> {
        assertWorkflowRunPermissionMode(options.permissionMode);
        const workflow = config.workflows[workflowId];
        if (!workflow)
            throw new Error(`Unknown workflow ${workflowId}`);
        const store = await this.runStore();
        const run = await store.createRun(workflowId, publicWorkflowInput(input), { sessionId: options.sessionId, configFingerprint: workflowConfigFingerprint(config, workflowId), permissionMode: options.permissionMode });
        const initialHandoff = await this.prepareInitialHandoff(input, run.runDir, options);
        const planRequestedPermissionRules = planRequestedPermissionRulesFromHandoff(initialHandoff);
        const stream = new EventStream<StoredEvent>();
        for (const event of await store.loadEvents(run.runId)) {
            stream.push(event);
        }
        const permissions = new PermissionController();
        const activeInputChannel = new ActiveTurnInputChannel<ModelMessage>();
        const startNodeId = resolveStartNodeId(workflow, options.startNodeId);
        const runPermissionMode = options.permissionMode;
        let interrupted = false;
        let controlRequest: WorkflowControlSignal | undefined;
        let lifecycleQueue: Promise<void> = Promise.resolve();
        let resultSettled = false;
        let activeRun: Promise<WorkflowState> | undefined;
        let activeAbortController: AbortController | undefined;
        let latestState: WorkflowState = {
            version: 5,
            status: "running",
            workflow_id: workflowId,
            config_fingerprint: workflowConfigFingerprint(config, workflowId),
            ...(runPermissionMode ? { run_permission_mode: runPermissionMode } : {}),
            ...(planRequestedPermissionRules.length ? { plan_requested_permission_rules: planRequestedPermissionRules } : {}),
            current_node_id: startNodeId,
            attempts: [],
            handoff: initialHandoff,
            node_checkpoints: {},
            suspended_stack: [],
            rework_count: 0,
            rework_limit: workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES
        };
        const stateListeners = new Set<(state: WorkflowState) => void>();
        const publishState = (nextState: WorkflowState) => {
            latestState = nextState;
            for (const listener of stateListeners) listener(nextState);
        };
        const subscribeState = (listener: (state: WorkflowState) => void) => {
            stateListeners.add(listener);
            return () => stateListeners.delete(listener);
        };
        const waitForBoundary = async () => {
            const boundary = await waitForWorkflowBoundary(() => latestState, subscribeState);
            const pendingRun = activeRun;
            if (pendingRun)
                await pendingRun;
            return boundary;
        };
        let resolveResult!: (state: WorkflowState) => void;
        let rejectResult!: (error: unknown) => void;
        let result!: Promise<WorkflowState>;
        const resetResult = () => {
            resultSettled = false;
            result = new Promise<WorkflowState>((resolve, reject) => {
                resolveResult = resolve;
                rejectResult = reject;
            });
        };
        resetResult();
        const finish = (state: WorkflowState) => {
            publishState(state);
            if (!resultSettled) {
                resultSettled = true;
                resolveResult(state);
            }
            stream.end();
        };
        const fail = async (error: unknown) => {
            const formatted = formatRunError(error);
            const failedState: WorkflowState = { ...latestState, status: "paused" };
            publishState(failedState);
            await store.saveState(run.runId, failedState);
            await this.appendEvent(store, run.runId, { type: "run_failed", error: formatted.message, ...(formatted.detail ? { detail: formatted.detail } : {}) }, (event) => stream.push(event));
            if (!resultSettled) {
                resultSettled = true;
                rejectResult(error);
            }
            stream.end();
        };
        const finishWhenTerminal = (state: WorkflowState) => {
            publishState(state);
            if (state.status === "completed" || state.status === "cancelled" || state.status === "failed")
                finish(state);
        };
        const runSegment = async (segment: {
            startNodeId: string;
            initialHandoff: unknown;
            attempts: WorkflowState["attempts"];
            resume?: ContinueOptions["resume"];
        }) => {
            if (activeRun)
                throw new Error(`Run ${run.runId} is already active`);
            const abortController = new AbortController();
            activeAbortController = abortController;
            activeRun = this.continueFrom({
                config,
                workflowId,
                workflow,
                store,
                runId: run.runId,
                startNodeId: segment.startNodeId,
                initialHandoff: segment.initialHandoff,
                attempts: segment.attempts,
                nodeCheckpoints: latestState.node_checkpoints,
                suspendedStack: latestState.suspended_stack,
                reworkCount: latestState.rework_count,
                reworkLimit: latestState.rework_limit,
                resume: segment.resume,
                runPermissionMode: latestState.run_permission_mode,
                planRequestedPermissionRules: latestState.plan_requested_permission_rules,
                eventSink: (event) => stream.push(event),
                interaction: {
                    requestPermission: (request) => permissions.request(request)
                },
                activeInputChannel,
                abortSignal: abortController.signal,
                isInterrupted: () => interrupted,
                controlSignal: () => controlRequest,
                onState: publishState
            });
            try {
                const state = await activeRun;
                finishWhenTerminal(state);
                return state;
            }
            finally {
                if (activeAbortController === abortController)
                    activeAbortController = undefined;
                activeRun = undefined;
            }
        };
        void runSegment({ startNodeId, initialHandoff, attempts: [] }).catch((error) => {
            void fail(error);
        });
        const withRunLease = async (task: () => Promise<void>): Promise<void> => {
            const lease = await store.acquireRunLease(run.runId);
            try {
                await task();
            }
            finally {
                await lease.release();
            }
        };
        const enqueueLifecycle = (task: () => Promise<void>): Promise<void> => {
            const queued = lifecycleQueue.catch(() => undefined).then(task);
            lifecycleQueue = queued.catch(() => undefined);
            return queued;
        };
        const dispatchToNode = (nodeId: string, input: unknown, dispatchOptions: WorkflowDispatchOptions = {}) => enqueueLifecycle(() => withRunLease(async () => {
            const continuingTerminal = latestState.status === "completed"
                || latestState.status === "cancelled"
                || latestState.status === "failed";
            if (resultSettled) resetResult();
            if (continuingTerminal) {
                stream.reopen();
                const continuedState: WorkflowState = {
                    ...latestState,
                    status: "pending",
                    pending_interaction: undefined,
                    final_summary: undefined
                };
                publishState(continuedState);
                await store.saveState(run.runId, continuedState);
                await this.appendEvent(store, run.runId, {
                    type: "run_continued",
                    workflow_id: workflowId,
                    input: publicWorkflowInput(input)
                }, (event) => stream.push(event));
            }
            resolveStartNodeId(workflow, nodeId);
            const fromNodeId = latestState.current_node_id;
            if (activeRun) {
                controlRequest = "dispatch";
                interrupted = false;
                permissions.resolveAll("deny_once");
                activeAbortController?.abort();
                await activeRun;
            }
            controlRequest = undefined;
            interrupted = false;
            const preparedInput = await this.prepareInitialHandoff(input, store.runDir(run.runId));
            const handoff = busDispatchHandoff(latestState.handoff, preparedInput, fromNodeId, nodeId, dispatchOptions.reason);
            const dispatchState = workflowDispatchState(latestState, workflow, nodeId, handoff, dispatchOptions);
            publishState(dispatchState);
            await store.saveState(run.runId, dispatchState);
            stream.reopen();
            await this.appendEvent(store, run.runId, {
                type: "bus_node_dispatched",
                ...(fromNodeId ? { from_node_id: fromNodeId } : {}),
                to_node_id: nodeId,
                ...(dispatchOptions.reason ? { reason: dispatchOptions.reason } : {})
            }, (event) => stream.push(event));
            void runSegment({ startNodeId: nodeId, initialHandoff: handoff, attempts: latestState.attempts }).catch((error) => {
                void fail(error);
            });
        }));
        const finalize = (summary: string) => enqueueLifecycle(() => withRunLease(async () => {
            const document = summary.trim();
            if (!document) throw new Error("Task summary must not be empty");
            if (resultSettled) {
                if (latestState.status === "completed") return;
                throw new Error(`Run ${run.runId} is already settled`);
            }
            if (activeRun) {
                controlRequest = "finalize";
                interrupted = false;
                permissions.resolveAll("deny_once");
                activeAbortController?.abort();
                await activeRun;
            }
            controlRequest = undefined;
            interrupted = false;
            const artifact = await new ArtifactStore(store.runDir(run.runId)).writeText("bus", "final-summary.md", `${document}\n`, {
                description: "Workflow bus final summary",
                attempt: 1,
                activation: 1
            });
            await this.appendEvent(store, run.runId, { type: "artifact_created", node_id: "bus", artifact_id: artifact.artifactId, path: artifact.path }, (event) => stream.push(event));
            await this.appendEvent(store, run.runId, { type: "complete_summary_available", node_id: "bus", attempt: 1, activation: 1, document }, (event) => stream.push(event));
            const finalState: WorkflowState = {
                ...latestState,
                status: "completed",
                pending_interaction: undefined,
                final_summary: document
            };
            publishState(finalState);
            await store.saveState(run.runId, finalState);
            await this.appendEvent(store, run.runId, {
                type: "run_completed",
                result: {
                    status: finalState.status,
                    workflow_id: finalState.workflow_id,
                    summary: document,
                    artifact_id: artifact.artifactId
                }
            }, (event) => stream.push(event));
            finish(finalState);
        }));
        const session: WorkflowSession = {
            sessionId: run.sessionId,
            runId: run.runId,
            get state() { return latestState; },
            events: stream,
            permissions,
            interrupt: async () => {
                if ((resultSettled && !activeRun) || interrupted)
                    return;
                interrupted = true;
                controlRequest = "interrupt";
                permissions.resolveAll("deny_once");
                activeAbortController?.abort();
                if (activeRun) {
                    publishState(await activeRun);
                    return;
                }
                const state = await this.pauseStateForUser({
                    store,
                    runId: run.runId,
                    workflowId,
                    latestState,
                    eventSink: (event) => stream.push(event)
                });
                publishState(state);
            },
            resumeWithUserInput: (input) => withRunLease(async () => {
                if (activeRun)
                    await activeRun;
                if (latestState.status !== "waiting_user" && latestState.status !== "paused")
                    throw new Error(`Run ${run.runId} is not waiting for user input`);
                if (resultSettled) resetResult();
                if (!latestState.current_node_id)
                    throw new Error(`Run ${run.runId} has no current node`);
                interrupted = false;
                controlRequest = undefined;
                stream.reopen();
                const guarded = resolveReworkLimitInput(latestState, workflow, input);
                if (guarded) {
                    publishState(guarded.state);
                    await store.saveState(run.runId, guarded.state);
                    if (guarded.type === "cancel") {
                        await this.appendEvent(store, run.runId, { type: "run_cancelled", reason: "用户在返工上限处终止工作流" }, (event) => stream.push(event));
                        finishWhenTerminal(guarded.state);
                        return;
                    }
                    await this.appendEvent(store, run.runId, { type: "transition", from: guarded.fromNodeId, to: guarded.targetNodeId, reason: "backward", activation: guarded.activation }, (event) => stream.push(event));
                    const nextState = await runSegment({ startNodeId: guarded.targetNodeId, initialHandoff: guarded.handoff, attempts: guarded.state.attempts, resume: guarded.resume });
                    finishWhenTerminal(nextState);
                    return;
                }
                const checkpointResume = resumeFromCheckpoint(latestState, input);
                if (checkpointResume) {
                    await recoverCheckpointResumeHandoff(store, run.runId, latestState, checkpointResume);
                    await this.persistCheckpointResume(store, run.runId, checkpointResume, (event) => stream.push(event));
                    const state = await runSegment({
                        startNodeId: checkpointResume.nodeId,
                        initialHandoff: checkpointResume.handoff,
                        attempts: latestState.attempts,
                        resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, activation: checkpointResume.activation, handoff: checkpointResume.handoff, dialogueMessages: checkpointResume.dialogueMessages, dialogueCursor: checkpointResume.dialogueCursor }
                    });
                    finishWhenTerminal(state);
                    return;
                }
                await this.appendEvent(store, run.runId, {
                    type: "user_message",
                    text: userMessageText(input),
                    node_id: latestState.current_node_id,
                    attempt: latestState.attempts.filter((attempt) => attempt.node_id === latestState.current_node_id).length + 1
                }, (event) => stream.push(event));
                const recoveredHandoff = await recoverLatestIncomingHandoff(store, run.runId, latestState, latestState.handoff);
                const state = await runSegment({
                    startNodeId: latestState.current_node_id,
                    initialHandoff: resumeHandoffWithUserInput(recoveredHandoff, input),
                    attempts: latestState.attempts
                });
                finishWhenTerminal(state);
            }),
            queueUserInput: async (input, inputId) => activeInputChannel.offer(userInputModelMessage(input), inputId),
            continueWithInput: (input) => {
                stream.reopen();
                return withRunLease(async () => {
                    if (activeRun)
                        await activeRun;
                    if (latestState.status === "running" || latestState.status === "waiting_user" || latestState.status === "paused") {
                        throw new Error(`Run ${run.runId} is not paused`);
                    }
                    const continuingTerminal = latestState.status === "completed"
                        || latestState.status === "cancelled"
                        || latestState.status === "failed";
                    if (resultSettled) resetResult();
                    if (continuingTerminal) {
                        const continuedState: WorkflowState = {
                            ...latestState,
                            status: "pending",
                            pending_interaction: undefined,
                            final_summary: undefined
                        };
                        publishState(continuedState);
                        await store.saveState(run.runId, continuedState);
                        await this.appendEvent(store, run.runId, {
                            type: "run_continued",
                            workflow_id: workflowId,
                            input: publicWorkflowInput(input)
                        }, (event) => stream.push(event));
                    }
                    interrupted = false;
                    controlRequest = undefined;
                    if (latestState.resume_checkpoint) {
                        const checkpointResume = resumeFromCheckpoint(latestState, input);
                        if (checkpointResume) {
                            await recoverCheckpointResumeHandoff(store, run.runId, latestState, checkpointResume);
                            await this.persistCheckpointResume(store, run.runId, checkpointResume, (event) => stream.push(event));
                            const state = await runSegment({
                                startNodeId: checkpointResume.nodeId,
                                initialHandoff: checkpointResume.handoff,
                                attempts: latestState.attempts,
                                resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, activation: checkpointResume.activation, handoff: checkpointResume.handoff, dialogueMessages: checkpointResume.dialogueMessages, dialogueCursor: checkpointResume.dialogueCursor }
                            });
                            finishWhenTerminal(state);
                            return;
                        }
                        const checkpoint = latestState.resume_checkpoint;
                        await this.appendEvent(store, run.runId, {
                            type: "user_message",
                            text: userMessageText(input),
                            node_id: checkpoint.node_id,
                            attempt: latestState.attempts.filter((attempt) => attempt.node_id === checkpoint.node_id).length + 1
                        }, (event) => stream.push(event));
                        const recoveredHandoff = await recoverLatestIncomingHandoff(store, run.runId, latestState, checkpoint.handoff);
                        const state = await runSegment({
                            startNodeId: checkpoint.node_id,
                            initialHandoff: resumeHandoffWithUserInput(recoveredHandoff, input, true),
                            attempts: latestState.attempts
                        });
                        finishWhenTerminal(state);
                        return;
                    }
                    const initialHandoff = await this.prepareInitialHandoff(input, run.runDir);
                    const state = await runSegment({
                        startNodeId,
                        initialHandoff,
                        attempts: latestState.attempts
                    });
                    finishWhenTerminal(state);
                });
            },
            dispatchToNode,
            finalize,
            subscribeState,
            waitForBoundary,
            get result() { return result; },
            set result(value: Promise<WorkflowState>) { result = value; }
        };
        return session;
    }
    private async persistCheckpointResume(
        store: RunStore,
        runId: string,
        resume: NonNullable<ReturnType<typeof resumeFromCheckpoint>>,
        eventSink?: (event: StoredEvent) => void
    ): Promise<void> {
        resume.dialogueCursor = await store.syncWorkflowDialogue(runId, resume.nodeId, resume.attempt, resume.dialogueMessages);
        await this.appendEvent(store, runId, {
            type: "user_message",
            text: resume.userText,
            node_id: resume.nodeId,
            attempt: resume.attempt
        }, eventSink);
    }
    private async continueSavedCheckpointWithInput(input: {
        config: AgentTeamConfig;
        workflowId: string;
        workflow: WorkflowConfig;
        store: RunStore;
        runId: string;
        state: WorkflowState;
        input: unknown;
    }): Promise<WorkflowState | undefined> {
        const checkpointResume = resumeFromCheckpoint(input.state, input.input);
        if (!checkpointResume)
            return undefined;
        await recoverCheckpointResumeHandoff(input.store, input.runId, input.state, checkpointResume);
        await this.persistCheckpointResume(input.store, input.runId, checkpointResume);
        return this.continueFrom({
            config: input.config,
            workflowId: input.workflowId,
            workflow: input.workflow,
            store: input.store,
            runId: input.runId,
            startNodeId: checkpointResume.nodeId,
            initialHandoff: checkpointResume.handoff,
            attempts: input.state.attempts,
            nodeCheckpoints: input.state.node_checkpoints,
            suspendedStack: input.state.suspended_stack,
            reworkCount: input.state.rework_count,
            reworkLimit: input.state.rework_limit,
            resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, activation: checkpointResume.activation, handoff: checkpointResume.handoff, dialogueMessages: checkpointResume.dialogueMessages, dialogueCursor: checkpointResume.dialogueCursor },
            runPermissionMode: input.state.run_permission_mode,
            planRequestedPermissionRules: input.state.plan_requested_permission_rules
        });
    }
    private async continueFrom(options: ContinueOptions): Promise<WorkflowState> {
        const lease = await options.store.acquireRunLease(options.runId);
        try {
        const configFingerprint = options.configFingerprint ?? workflowConfigFingerprint(options.config, options.workflowId);
        options.configFingerprint = configFingerprint;
        const basePermissions = options.workflow.workflow_permissions ?? permissionSetSchema.parse(undefined);
        const planRequestedPermissionRules = options.planRequestedPermissionRules?.length
            ? options.planRequestedPermissionRules
            : planRequestedPermissionRulesFromHandoff(options.initialHandoff);
        options.planRequestedPermissionRules = planRequestedPermissionRules;
        const attempts = options.attempts.map((attempt) => ({ ...attempt, activation: attempt.activation ?? 1, activations: [...attempt.activations ?? []] }));
        const nodeCheckpoints = { ...options.nodeCheckpoints };
        let suspendedStack = [...options.suspendedStack ?? []];
        let reworkCount = options.reworkCount ?? 0;
        const reworkLimit = options.reworkLimit ?? options.workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES;
        let currentId: string | undefined = options.startNodeId;
        let handoff: unknown = options.initialHandoff;
        let pendingResume = options.resume;
        const syncOptions = () => {
            options.nodeCheckpoints = nodeCheckpoints;
            options.suspendedStack = suspendedStack;
            options.reworkCount = reworkCount;
            options.reworkLimit = reworkLimit;
        };
        const stateBase = () => ({
            version: 5 as const,
            workflow_id: options.workflowId,
            config_fingerprint: configFingerprint,
            node_checkpoints: { ...nodeCheckpoints },
            suspended_stack: [...suspendedStack],
            rework_count: reworkCount,
            rework_limit: reworkLimit,
            ...(options.runPermissionMode ? { run_permission_mode: options.runPermissionMode } : {}),
            ...(planRequestedPermissionRules.length ? { plan_requested_permission_rules: planRequestedPermissionRules } : {})
        });
        while (currentId) {
            syncOptions();
            const pendingControl = options.controlSignal?.();
            if (pendingControl === "dispatch" || pendingControl === "finalize") {
                return this.awaitBusControl(options, currentId, attempts, handoff, undefined, pendingControl);
            }
            if (pendingControl === "interrupt" || options.isInterrupted?.()) {
                return this.pauseNodeForUser(options, currentId, attempts, handoff);
            }
            const node = options.workflow.nodes.find((item) => item.id === currentId);
            if (!node) throw new Error(`Unknown node ${currentId}`);
            const role = options.config.roles[node.role];
            const providerConfig = options.config.providers[node.provider];
            const effectivePermissionMode = options.runPermissionMode ?? node.permission_mode;
            const resume = pendingResume?.nodeId === node.id ? pendingResume : undefined;
            if (resume?.handoff !== undefined) handoff = resume.handoff;
            this.assertCapabilities(node, role.requires, providerConfig.capabilities, handoff);
            let attemptIndex = findLatestAttemptIndex(attempts, node.id);
            const attempt = resume?.attempt ?? (attemptIndex >= 0 ? attempts[attemptIndex]!.attempt : 1) ?? 1;
            const activation = resume?.activation ?? (attemptIndex >= 0 ? (attempts[attemptIndex]!.activation ?? 0) + 1 : 1);
            let dialogueMessages = resume?.dialogueMessages ?? [];
            let dialogueCursor = resume?.dialogueCursor ?? dialogueMessages.length;
            const activationState = { activation, status: "running" as const };
            if (attemptIndex < 0) {
                attempts.push({ node_id: node.id, attempt, activation, status: "running", activations: [activationState] });
                attemptIndex = attempts.length - 1;
            }
            else {
                const previous = attempts[attemptIndex]!;
                attempts[attemptIndex] = {
                    ...previous,
                    activation,
                    status: "running",
                    activations: previous.activations.some((item) => item.activation === activation)
                        ? previous.activations.map((item) => item.activation === activation ? activationState : item)
                        : [...previous.activations, activationState]
                };
            }
            pendingResume = undefined;
            options.resume = undefined;
            const checkpoint = () => {
                const value = { node_id: node.id, handoff, attempt, activation, dialogue_cursor: dialogueCursor, dialogue_messages: dialogueMessages };
                nodeCheckpoints[node.id] = value;
                return value;
            };
            const runningState: WorkflowState = {
                status: "running",
                ...stateBase(),
                current_node_id: node.id,
                attempts,
                handoff,
                resume_checkpoint: checkpoint()
            };
            options.onState?.(runningState);
            await options.store.saveState(options.runId, runningState);
            await this.appendEvent(options.store, options.runId, { type: "node_started", node_id: node.id, attempt, activation }, options.eventSink);
            const tools = createLocalToolRegistry({
                mcpRuntime: this.options.mcpRuntime,
                skillRuntime: this.options.skillRuntime,
                onManagedProcessEvent: async (event) => {
                    await this.appendEvent(options.store, options.runId, {
                        ...event,
                        node_id: node.id,
                        attempt,
                        activation
                    }, options.eventSink);
                }
            });
            let result: NodeResult | undefined;
            let waitingUserResult: NodeWaitingUserResult | undefined;
            let nodeError: unknown;
            options.activeInputChannel?.open();
            try {
                result = await runNode({
                    node,
                    navigation: this.transitionController.navigation(options.workflow, node.id),
                    systemPrompt: effectiveSystemPrompt(options.config.global_prompt, role.system_prompt),
                    model: resolveModelForWorkflowNode({ node, role, provider: providerConfig, permissionMode: effectivePermissionMode, planModel: providerConfig.plan_model, registry: modelRegistryFromProviderConfig(providerConfig) }),
                    effort: resolveEffortForWorkflowNode({ node, provider: providerConfig }),
                    modelRegistry: modelRegistryFromProviderConfig(providerConfig),
                    maxOutputTokens: getProviderMaxOutputTokens(providerConfig),
                    supportsVision: providerConfig.capabilities.vision,
                    provider: this.options.providerFactory(node.provider),
                    tools,
                    permissions: workflowToolPermissions(effectivePermissionMode, basePermissions, node.permissions ?? permissionSetSchema.parse(undefined), planRequestedPermissionRules),
                    cwd: this.options.cwd,
                    runId: options.runId,
                    store: options.store,
                    handoff,
                    attempt,
                    activation,
                    interaction: options.interaction,
                    eventSink: options.eventSink,
                    drainPendingUserInputs: () => options.activeInputChannel?.drain() ?? [],
                    onUserInputRequested: (request) => {
                        waitingUserResult = request;
                    },
                    abortSignal: options.abortSignal,
                    dialogueMessages,
                    dialogueCursor,
                    onDialogueMessage: async (message) => {
                        dialogueMessages.push(message);
                        dialogueCursor = await options.store.syncWorkflowDialogue(options.runId, node.id, attempt, dialogueMessages);
                        return dialogueCursor;
                    },
                    onDialogueCompacted: async (messages, cursor) => {
                        dialogueMessages = [...messages];
                        dialogueCursor = cursor;
                    }
                });
            }
            catch (error) {
                nodeError = error;
            }
            finally {
                const deferredInputs = options.activeInputChannel?.close() ?? [];
                for (const pending of deferredInputs) {
                    const content = pending.input.content;
                    const text = typeof content === "string"
                        ? content
                        : content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
                    await this.appendEvent(options.store, options.runId, {
                        type: "user_input_deferred",
                        input_id: pending.id,
                        text: text || "See attached image.",
                        node_id: node.id,
                        attempt,
                        activation
                    }, options.eventSink);
                }
            }
            let cleanupError: unknown;
            const cleanupReason = options.controlSignal?.() || options.isInterrupted?.() || options.abortSignal?.aborted
                ? "interrupted"
                : nodeError
                    ? "node_error"
                    : "node_complete";
            try {
                await tools.disposeManagedProcesses(cleanupReason);
            }
            catch (error) {
                cleanupError = error;
            }
            if (nodeError || cleanupError) {
                syncOptions();
                const control = options.controlSignal?.();
                if (control === "dispatch" || control === "finalize") {
                    return this.awaitBusControl(options, node.id, attempts, handoff, checkpoint(), control);
                }
                if (control === "interrupt" || options.isInterrupted?.() || options.abortSignal?.aborted) {
                    return this.pauseNodeForUser(options, node.id, attempts, handoff, checkpoint());
                }
                const error = nodeError && cleanupError
                    ? new AggregateError([nodeError, cleanupError], "Node execution and managed process cleanup failed")
                    : nodeError ?? cleanupError;
                return this.failNodeForUser(options, node.id, attempt, attempts, handoff, error, checkpoint());
            }
            const completedControl = options.controlSignal?.();
            if (completedControl === "dispatch" || completedControl === "finalize") {
                syncOptions();
                return this.awaitBusControl(options, node.id, attempts, handoff, checkpoint(), completedControl);
            }
            if (completedControl === "interrupt" || options.isInterrupted?.()) {
                syncOptions();
                return this.pauseNodeForUser(options, node.id, attempts, handoff, checkpoint());
            }
            if (waitingUserResult) {
                syncOptions();
                return this.waitForUserQuestions(options, node.id, attempt, activation, attempts, attemptIndex, handoff, waitingUserResult.questions, waitingUserResult, checkpoint());
            }
            try {
                result = await this.ensureNodeDeliverable(options, node.id, attempt, result!, activation);
                const resolution = this.transitionController.resolve({
                    workflow: options.workflow,
                    nodeId: node.id,
                    result,
                    suspendedStack,
                    reworkCount,
                    reworkLimit
                });
                const currentCheckpoint = checkpoint();
                if (resolution.type === "user") {
                    syncOptions();
                    return this.waitForUserQuestions(options, node.id, attempt, activation, attempts, attemptIndex, handoff, result.questions, result, currentCheckpoint);
                }
                if (resolution.type === "rework_limit") {
                    const questions = reworkLimitQuestions(reworkLimit);
                    setAttemptOutcome(attempts, attemptIndex, activation, "waiting_user", "waiting_user", result);
                    const pendingInteraction = { type: "rework_limit" as const, node_id: node.id, questions, result };
                    const state: WorkflowState = {
                        status: "waiting_user",
                        ...stateBase(),
                        current_node_id: node.id,
                        attempts,
                        handoff,
                        resume_checkpoint: currentCheckpoint,
                        pending_interaction: pendingInteraction
                    };
                    await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: node.id, attempt, activation, questions }, options.eventSink);
                    options.onState?.(state);
                    await options.store.saveState(options.runId, state);
                    return state;
                }
                if (resolution.type === "complete") {
                    setAttemptOutcome(attempts, attemptIndex, activation, "completed", "forwarded", result);
                    await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: node.id, attempt, activation, status: "completed", result }, options.eventSink);
                    const awaitingState: WorkflowState = {
                        status: "awaiting_bus",
                        ...stateBase(),
                        current_node_id: node.id,
                        attempts,
                        handoff,
                        resume_checkpoint: currentCheckpoint
                    };
                    options.onState?.(awaitingState);
                    await options.store.saveState(options.runId, awaitingState);
                    await this.appendEvent(options.store, options.runId, { type: "run_awaiting_bus", node_id: node.id, reason: "workflow_boundary" }, options.eventSink);
                    return awaitingState;
                }
                suspendedStack = resolution.suspended_stack;
                reworkCount = resolution.rework_count;
                syncOptions();
                const target = resolution.target_node_id;
                const targetHandoff = buildHandoff(target, node.id, result, attempts.find((item) => item.node_id === target)?.attempt ?? 1);
                setAttemptOutcome(
                    attempts,
                    attemptIndex,
                    activation,
                    result.direction === "retry" ? "running" : result.direction === "backward" ? "suspended" : "completed",
                    result.direction === "retry" ? "retrying" : result.direction === "backward" ? "returned" : "forwarded",
                    result
                );
                await this.appendEvent(options.store, options.runId, {
                    type: "node_completed",
                    node_id: node.id,
                    attempt,
                    activation,
                    status: result.direction === "retry" ? "retrying" : result.direction === "backward" ? "suspended" : "completed",
                    result
                }, options.eventSink);
                await this.appendEvent(options.store, options.runId, { type: "transition", from: node.id, to: target, reason: result.direction, activation }, options.eventSink);
                const savedTarget = nodeCheckpoints[target];
                if (resolution.resume && savedTarget) {
                    const resumedHandoff = buildResumeHandoff(savedTarget.handoff, targetHandoff);
                    const resumedMessages = [...savedTarget.dialogue_messages ?? [], controllerReturnMessage(node.id, result, targetHandoff)];
                    const resumedAttempt = savedTarget.attempt ?? 1;
                    const resumedCursor = await options.store.syncWorkflowDialogue(options.runId, target, resumedAttempt, resumedMessages);
                    pendingResume = {
                        nodeId: target,
                        attempt: resumedAttempt,
                        activation: (savedTarget.activation ?? 0) + 1,
                        handoff: resumedHandoff,
                        dialogueMessages: resumedMessages,
                        dialogueCursor: resumedCursor
                    };
                    handoff = resumedHandoff;
                }
                else {
                    pendingResume = undefined;
                    handoff = targetHandoff;
                }
                const nextCheckpoint = pendingResume
                    ? { node_id: target, handoff, attempt: pendingResume.attempt, activation: pendingResume.activation ?? 1, dialogue_cursor: pendingResume.dialogueCursor, dialogue_messages: pendingResume.dialogueMessages }
                    : { node_id: target, handoff, attempt: 1, activation: 1, dialogue_cursor: 0, dialogue_messages: [] };
                nodeCheckpoints[target] = nextCheckpoint;
                const transitionState: WorkflowState = {
                    status: "running",
                    ...stateBase(),
                    current_node_id: target,
                    attempts,
                    handoff,
                    resume_checkpoint: nextCheckpoint
                };
                options.onState?.(transitionState);
                await options.store.saveState(options.runId, transitionState);
                currentId = target;
            }
            catch (error) {
                syncOptions();
                const control = options.controlSignal?.();
                if (control === "dispatch" || control === "finalize") {
                    return this.awaitBusControl(options, node.id, attempts, handoff, checkpoint(), control);
                }
                if (control === "interrupt" || options.isInterrupted?.() || options.abortSignal?.aborted) {
                    return this.pauseNodeForUser(options, node.id, attempts, handoff, checkpoint());
                }
                return this.failNodeForUser(options, node.id, attempt, attempts, handoff, error, checkpoint());
            }
        }
        return { status: "awaiting_bus", ...stateBase(), attempts, handoff };
        }
        finally {
            await lease.release();
        }
    }
    private async continueReworkLimitWithInput(input: {
        config: AgentTeamConfig;
        workflowId: string;
        workflow: WorkflowConfig;
        store: RunStore;
        runId: string;
        state: WorkflowState;
        input: unknown;
    }): Promise<WorkflowState | undefined> {
        const resolution = resolveReworkLimitInput(input.state, input.workflow, input.input);
        if (!resolution) return undefined;
        if (resolution.type === "cancel") {
            await input.store.saveState(input.runId, resolution.state);
            await this.appendEvent(input.store, input.runId, { type: "run_cancelled", reason: "用户在返工上限处终止工作流" });
            return resolution.state;
        }
        if (resolution.resume) {
            const cursor = await input.store.syncWorkflowDialogue(input.runId, resolution.resume.nodeId, resolution.resume.attempt, resolution.resume.dialogueMessages);
            resolution.resume.dialogueCursor = cursor;
            if (resolution.state.resume_checkpoint) resolution.state.resume_checkpoint.dialogue_cursor = cursor;
            const targetCheckpoint = resolution.state.node_checkpoints?.[resolution.targetNodeId];
            if (targetCheckpoint) targetCheckpoint.dialogue_cursor = cursor;
        }
        await input.store.saveState(input.runId, resolution.state);
        await this.appendEvent(input.store, input.runId, {
            type: "transition",
            from: resolution.fromNodeId,
            to: resolution.targetNodeId,
            reason: resolution.reason,
            activation: resolution.activation
        });
        return this.continueFrom({
            config: input.config,
            workflowId: input.workflowId,
            workflow: input.workflow,
            store: input.store,
            runId: input.runId,
            startNodeId: resolution.targetNodeId,
            initialHandoff: resolution.handoff,
            attempts: resolution.state.attempts,
            nodeCheckpoints: resolution.state.node_checkpoints,
            suspendedStack: resolution.state.suspended_stack,
            reworkCount: resolution.state.rework_count,
            reworkLimit: resolution.state.rework_limit,
            resume: resolution.resume,
            runPermissionMode: resolution.state.run_permission_mode,
            planRequestedPermissionRules: resolution.state.plan_requested_permission_rules
        });
    }

    private async waitForUserQuestions(
        options: ContinueOptions,
        nodeId: string,
        attempt: number,
        activation: number,
        attempts: WorkflowState["attempts"],
        attemptIndex: number,
        handoff: unknown,
        questions: NodeResult["questions"],
        result: unknown,
        resumeCheckpoint: WorkflowState["resume_checkpoint"]
    ): Promise<WorkflowState> {
        setAttemptOutcome(attempts, attemptIndex, activation, "waiting_user", "waiting_user", result);
        const state: WorkflowState = {
            status: "waiting_user",
            workflow_id: options.workflowId,
            ...continuationStateFields(options, resumeCheckpoint),
            current_node_id: nodeId,
            attempts,
            handoff,
            resume_checkpoint: resumeCheckpoint,
            pending_interaction: { type: "node_user", node_id: nodeId, questions }
        };
        options.onState?.(state);
        await options.store.saveState(options.runId, state);
        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: nodeId, attempt, activation, questions }, options.eventSink);
        return state;
    }

    private async failNodeForUser(options: ContinueOptions, nodeId: string, attempt: number, attempts: WorkflowState["attempts"], handoff: unknown, error: unknown, resumeCheckpoint?: WorkflowState["resume_checkpoint"]): Promise<WorkflowState> {
        const activation = resumeCheckpoint?.activation ?? latestActivationForNode(attempts, nodeId);
        const result = await this.ensureNodeDeliverable(options, nodeId, attempt, errorNodeResult(error), activation);
        const attemptIndex = findLatestAttemptIndex(attempts, nodeId);
        if (attemptIndex >= 0) setAttemptOutcome(attempts, attemptIndex, activation, "failure", "failed", result);
        await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: nodeId, attempt, activation, status: "failure", result }, options.eventSink);
        const checkpoint = resumeCheckpoint ?? { node_id: nodeId, handoff, attempt, activation, dialogue_cursor: 0, dialogue_messages: [] };
        const questions = result.questions;
        const state: WorkflowState = {
            status: "paused",
            workflow_id: options.workflowId,
            ...continuationStateFields(options, checkpoint),
            ...(options.runPermissionMode ? { run_permission_mode: options.runPermissionMode } : {}),
            ...(options.planRequestedPermissionRules?.length ? { plan_requested_permission_rules: options.planRequestedPermissionRules } : {}),
            current_node_id: nodeId,
            attempts,
            handoff,
            resume_checkpoint: checkpoint,
            pending_interaction: { type: "node_user", node_id: nodeId, questions }
        };
        options.onState?.(state);
        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: nodeId, attempt, activation, questions }, options.eventSink);
        await options.store.saveState(options.runId, state);
        return state;
    }
    private async awaitBusControl(
        options: ContinueOptions,
        nodeId: string,
        attempts: WorkflowState["attempts"],
        handoff: unknown,
        resumeCheckpoint: WorkflowState["resume_checkpoint"] | undefined,
        control: Extract<WorkflowControlSignal, "dispatch" | "finalize">
    ): Promise<WorkflowState> {
        const updatedAttempts = markLatestActiveAttemptSuspended(attempts, nodeId);
        const attempt = latestAttemptForNode(updatedAttempts, nodeId);
        const activation = latestActivationForNode(updatedAttempts, nodeId);
        const checkpoint = resumeCheckpoint ?? { node_id: nodeId, handoff, attempt, activation, dialogue_cursor: 0, dialogue_messages: [] };
        const state: WorkflowState = {
            status: "awaiting_bus",
            workflow_id: options.workflowId,
            ...continuationStateFields(options, checkpoint),
            ...(options.runPermissionMode ? { run_permission_mode: options.runPermissionMode } : {}),
            ...(options.planRequestedPermissionRules?.length ? { plan_requested_permission_rules: options.planRequestedPermissionRules } : {}),
            current_node_id: nodeId,
            attempts: updatedAttempts,
            handoff,
            resume_checkpoint: checkpoint,
            pending_interaction: undefined
        };
        options.onState?.(state);
        await this.appendEvent(options.store, options.runId, { type: "node_interrupted", node_id: nodeId, attempt }, options.eventSink);
        await options.store.saveState(options.runId, state);
        await this.appendEvent(options.store, options.runId, {
            type: "run_awaiting_bus",
            node_id: nodeId,
            reason: control === "dispatch" ? "reassigned" : "finalizing"
        }, options.eventSink);
        return state;
    }

    private async pauseNodeForUser(options: ContinueOptions, nodeId: string, attempts: WorkflowState["attempts"], handoff: unknown, resumeCheckpoint?: WorkflowState["resume_checkpoint"]): Promise<WorkflowState> {
        const updatedAttempts = markLatestActiveAttemptWaiting(attempts, nodeId);
        const questions = conversationInterruptedQuestions();
        const attempt = latestAttemptForNode(updatedAttempts, nodeId);
        const activation = latestActivationForNode(updatedAttempts, nodeId);
        const checkpoint = resumeCheckpoint ?? { node_id: nodeId, handoff, attempt, activation, dialogue_cursor: 0, dialogue_messages: [] };
        const state: WorkflowState = {
            status: "paused",
            workflow_id: options.workflowId,
            ...continuationStateFields(options, checkpoint),
            ...(options.runPermissionMode ? { run_permission_mode: options.runPermissionMode } : {}),
            ...(options.planRequestedPermissionRules?.length ? { plan_requested_permission_rules: options.planRequestedPermissionRules } : {}),
            current_node_id: nodeId,
            attempts: updatedAttempts,
            handoff,
            resume_checkpoint: checkpoint,
            pending_interaction: { type: "node_user", node_id: nodeId, questions }
        };
        options.onState?.(state);
        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: nodeId, attempt, activation, questions }, options.eventSink);
        await options.store.saveState(options.runId, state);
        return state;
    }
    private async pauseStateForUser(input: {
        store: RunStore;
        runId: string;
        workflowId: string;
        latestState: WorkflowState;
        eventSink?: (event: StoredEvent) => void;
    }): Promise<WorkflowState> {
        const nodeId = input.latestState.current_node_id ?? input.latestState.resume_checkpoint?.node_id;
        if (!nodeId)
            return input.latestState;
        const lease = await input.store.acquireRunLease(input.runId);
        try {
        const checkpoint = input.latestState.resume_checkpoint;
        const handoff = checkpoint?.handoff ?? input.latestState.handoff;
        const attempts = markLatestActiveAttemptWaiting(input.latestState.attempts, nodeId);
        const questions = conversationInterruptedQuestions();
        const state: WorkflowState = {
            ...input.latestState,
            status: "paused",
            current_node_id: nodeId,
            attempts,
            handoff,
            resume_checkpoint: checkpoint ? { ...checkpoint, node_id: nodeId, handoff } : { node_id: nodeId, handoff, attempt: latestAttemptForNode(attempts, nodeId), activation: latestActivationForNode(attempts, nodeId), dialogue_cursor: 0, dialogue_messages: [] },
            pending_interaction: { type: "node_user", node_id: nodeId, questions }
        };
        await this.appendEvent(input.store, input.runId, { type: "node_waiting_user", node_id: nodeId, questions }, input.eventSink);
        await input.store.saveState(input.runId, state);
        return state;
        }
        finally {
            await lease.release();
        }
    }
    private async ensureNodeDeliverable(options: ContinueOptions, nodeId: string, attempt: number, result: NodeResult, activation = 1): Promise<NodeResult> {
        const runDir = options.store.runDir(options.runId);
        const deliverables: NodeResult["deliverables"] = [];
        for (const deliverable of result.deliverables) {
            if (await artifactExists(runDir, nodeId, deliverable.artifact_id))
                deliverables.push(deliverable);
        }
        if (deliverables.length)
            return deliverables.length === result.deliverables.length ? result : { ...result, deliverables };
        const name = `node-output-${attempt}-a${activation}.md`;
        const ref = await new ArtifactStore(runDir).writeText(nodeId, name, nodeDeliverableMarkdown(nodeId, attempt, activation, result), { description: "节点交付物说明", attempt, activation });
        await this.appendEvent(options.store, options.runId, { type: "artifact_created", node_id: nodeId, artifact_id: ref.artifactId, path: ref.path }, options.eventSink);
        return { ...result, deliverables: [{ artifact_id: ref.artifactId, description: "节点交付物说明" }] };
    }
    private async appendEvent(store: RunStore, runId: string, event: HarnessEvent, sink?: (event: StoredEvent) => void): Promise<StoredEvent> {
        const stored = await store.appendEvent(runId, event);
        sink?.(stored);
        return stored;
    }
    private async prepareInitialHandoff(input: unknown, runDir: string, options: WorkflowRunOptions = {}): Promise<unknown> {
        if (!input || typeof input !== "object")
            return input;
        const handoff = options.clearContext === true ? clearContextPlanHandoff(input) : input;
        const images = (handoff as {
            images?: unknown;
        }).images;
        if (!Array.isArray(images) || !images.length)
            return handoff;
        const artifacts = new ArtifactStore(runDir);
        const refs = [];
        for (const image of images) {
            if (typeof image === "string") {
                const ref = await artifacts.copyInputImage(image);
                refs.push({ artifact_id: ref.artifactId, path: ref.path, media_type: ref.mediaType });
                continue;
            }
            if (!image || typeof image !== "object") {
                throw new Error("Unsupported workflow image input");
            }
            const item = image as Record<string, unknown>;
            if (
                item.type !== "image"
                || (item.media_type !== "image/png" && item.media_type !== "image/jpeg" && item.media_type !== "image/webp")
                || typeof item.data !== "string"
            ) {
                throw new Error("Unsupported workflow image input");
            }
            const mediaType = item.media_type;
            const ref = await artifacts.writeInputImage(item.data, mediaType);
            refs.push({ artifact_id: ref.artifactId, path: ref.path, media_type: ref.mediaType });
        }
        return { ...handoff as Record<string, unknown>, images: refs };
    }
    private assertCapabilities(node: WorkflowNodeConfig, requires: {
        tool_calling?: boolean;
        vision?: boolean;
    }, capabilities: {
        tool_calling?: boolean;
        vision?: boolean;
    }, handoff: unknown) {
        if (requires.tool_calling && !capabilities.tool_calling)
            throw new Error(`Node ${node.id} requires tool calling`);
        if ((requires.vision || handoffHasImages(handoff)) && !capabilities.vision)
            throw new Error(`Node ${node.id} requires vision`);
    }
}
async function artifactExists(runDir: string, nodeId: string, artifactId: string): Promise<boolean> {
    if (!nodeId) return false;
    return new ArtifactStore(runDir).has(artifactId);
}
function nodeDeliverableMarkdown(nodeId: string, attempt: number, activation: number, result: NodeResult): string {
    const lines = [`# ${nodeId} attempt ${attempt} activation ${activation} output`, "", `- 方向：${result.direction}`, `- 摘要：${result.summary || "无"}`];
    if (result.document.trim())
        lines.push("", "## 文档", "", result.document.trim());
    if (result.questions.length)
        lines.push("", "## 问题", "", ...result.questions.map((question) => `- ${question.text}`));
    if (result.feedback.defects.length || result.feedback.change_requests.length) {
        lines.push("", "## 反馈");
        for (const defect of result.feedback.defects)
            lines.push(`- 缺陷：${defect}`);
        for (const request of result.feedback.change_requests)
            lines.push(`- 变更请求：${request}`);
    }
    if (result.handoff.instruction)
        lines.push("", "## 交接", "", result.handoff.instruction);
    return `${lines.join("\n")}\n`;
}
function resolveStartNodeId(workflow: WorkflowConfig, requested: string | undefined): string {
    const nodeId = requested ?? firstNodeId(workflow);
    if (!workflow.nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown workflow start node ${nodeId}`);
    return nodeId;
}

function busDispatchHandoff(
    previousHandoff: unknown,
    input: unknown,
    fromNodeId: string | undefined,
    toNodeId: string,
    reason: string | undefined
): unknown {
    const publicInput = publicWorkflowInput(input);
    const payload = publicInput && typeof publicInput === "object" && !Array.isArray(publicInput)
        ? publicInput as Record<string, unknown>
        : { request: publicInput };
    const previousLayer = compactHandoffLayer(previousHandoff);
    return {
        ...payload,
        bus_dispatch: {
            ...(fromNodeId ? { from_node_id: fromNodeId } : {}),
            to_node_id: toNodeId,
            ...(reason ? { reason } : {})
        },
        ...(previousLayer !== undefined ? { previous_handoff: previousLayer } : {})
    };
}

function workflowDispatchState(
    state: WorkflowState,
    workflow: WorkflowConfig,
    nodeId: string,
    handoff: unknown,
    options: WorkflowDispatchOptions
): WorkflowState {
    const reworkCount = state.rework_count ?? 0;
    const reworkLimit = state.rework_limit ?? workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES;
    if (options.countsAsRework && reworkCount >= reworkLimit) {
        throw new Error(`Workflow rework limit reached: ${reworkLimit}`);
    }
    const permissionMode = options.permissionMode ?? state.run_permission_mode;
    const planRequestedPermissionRules = [...new Set(planRequestedPermissionRulesFromHandoff(handoff))];
    return {
        ...state,
        status: "running",
        current_node_id: nodeId,
        handoff,
        resume_checkpoint: undefined,
        pending_interaction: undefined,
        final_summary: undefined,
        rework_count: options.countsAsRework ? reworkCount + 1 : reworkCount,
        ...(permissionMode ? { run_permission_mode: permissionMode } : {}),
        plan_requested_permission_rules: planRequestedPermissionRules.length ? planRequestedPermissionRules : undefined
    };
}

function waitForWorkflowBoundary(
    currentState: () => WorkflowState,
    subscribe: (listener: (state: WorkflowState) => void) => () => void
): Promise<WorkflowState> {
    const current = currentState();
    if (isWorkflowBoundary(current)) return Promise.resolve(current);
    return new Promise((resolve) => {
        const unsubscribe = subscribe((state) => {
            if (!isWorkflowBoundary(state)) return;
            unsubscribe();
            resolve(state);
        });
    });
}

function isWorkflowBoundary(state: WorkflowState): boolean {
    return state.status === "awaiting_bus"
        || state.status === "waiting_user"
        || state.status === "paused"
        || state.status === "completed"
        || state.status === "cancelled"
        || state.status === "failed";
}

function effectiveSystemPrompt(globalPrompt: string | undefined, rolePrompt: string): string {
    const global = globalPrompt?.trim();
    return global ? `${global}\n\n${rolePrompt}` : rolePrompt;
}
function workflowToolPermissions(mode: WorkflowRunPermissionMode, base: PermissionSet, node: PermissionSet, planRequestedPermissionRules: string[] = []): ToolPermissionContext {
    const merged = mergePermissions(base ?? permissionSetSchema.parse(undefined), node ?? permissionSetSchema.parse(undefined));
    return { mode, source: "workflow", ...merged, allow: [...merged.allow, ...planRequestedPermissionRules] };
}
function assertWorkflowRunPermissionMode(mode: unknown): void {
    if (mode === "plan")
        throw new Error("Plan Mode must be approved before workflow execution starts");
}
function publicWorkflowInput(input: unknown): unknown {
    return stripInternalPlanModeHandoffMarkers(input);
}
function planRequestedPermissionRulesFromHandoff(handoff: unknown): string[] {
    const permissions = collectPlanRequestedPermissions(handoff);
    // The runtime treats Bash and PowerShell alike, so emitting only a Bash rule left every
    // approved permission dead on Windows, where the model reaches for PowerShell.
    return permissions
        .filter((permission) => permission.tool === "Bash" && permission.prompt.trim())
        .flatMap((permission) => {
            const prompt = permission.prompt.replace(/[()]/g, " ").trim();
            return [`Bash(prompt:${prompt})`, `PowerShell(prompt:${prompt})`];
        });
}
function clearContextPlanHandoff(input: unknown): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return input;
    const value = input as Record<string, unknown>;
    const approvedPlan = value.approved_plan;
    if (typeof approvedPlan !== "string" || !approvedPlan.trim())
        return input;
    const feedback = approvalFeedbackText(value.plan_approval_feedback);
    return {
        ...value,
        request: [
            "Implement the following plan:",
            "",
            approvedPlan.trim(),
            ...(feedback ? ["", `User feedback on this plan: ${feedback}`] : [])
        ].join("\n"),
        clear_context: true
    };
}
function approvalFeedbackText(feedback: unknown): string | undefined {
    if (typeof feedback === "string" && feedback.trim())
        return feedback.trim();
    if (!feedback || typeof feedback !== "object" || Array.isArray(feedback))
        return undefined;
    const answer = (feedback as { answer?: unknown }).answer;
    return typeof answer === "string" && answer.trim() ? answer.trim() : undefined;
}
function collectPlanRequestedPermissions(handoff: unknown): PlanRequestedPermission[] {
    if (!handoff || typeof handoff !== "object")
        return [];
    const value = handoff as { plan_requested_permissions?: unknown; previous_handoff?: unknown };
    const direct = Array.isArray(value.plan_requested_permissions)
        ? value.plan_requested_permissions.filter(isPlanRequestedPermission)
        : [];
    return [...direct, ...collectPlanRequestedPermissions(value.previous_handoff)];
}
function isPlanRequestedPermission(value: unknown): value is PlanRequestedPermission {
    if (!value || typeof value !== "object")
        return false;
    const item = value as { tool?: unknown; prompt?: unknown };
    return typeof item.tool === "string" && typeof item.prompt === "string";
}
function errorNodeResult(error: unknown): NodeResult {
    const formatted = formatRunError(error);
    const detail = formatted.detail ? `${formatted.message}

${formatted.detail}` : formatted.message;
    return {
        direction: "forward",
        summary: formatted.message,
        document: "",
        deliverables: [],
        feedback: { defects: [detail], change_requests: [] },
        questions: conversationInterruptedQuestions(),
        handoff: {
            instruction: "等待用户处理节点失败后继续执行。",
            must_follow: [],
            known_risks: [detail],
            open_questions: []
        }
    };
}
function conversationInterruptedQuestions(): NodeResult["questions"] {
    return [{ id: CONVERSATION_INTERRUPTED_QUESTION_ID, text: CONVERSATION_INTERRUPTED_TEXT, required: true }];
}
function markLatestActiveAttemptSuspended(attempts: WorkflowState["attempts"], nodeId: string): WorkflowState["attempts"] {
    const next = attempts.map((attempt) => ({ ...attempt, activations: [...attempt.activations ?? []] }));
    for (let index = next.length - 1; index >= 0; index -= 1) {
        const attempt = next[index]!;
        if (attempt.node_id !== nodeId || (attempt.status !== "running" && attempt.status !== "waiting_user")) continue;
        next[index] = {
            ...attempt,
            status: "suspended",
            activations: (attempt.activations ?? []).map((activation) => activation.activation === attempt.activation
                ? { ...activation, status: "interrupted" }
                : activation)
        };
        break;
    }
    return next;
}

function markLatestActiveAttemptWaiting(attempts: WorkflowState["attempts"], nodeId: string): WorkflowState["attempts"] {
    const next = [...attempts];
    for (let index = next.length - 1; index >= 0; index -= 1) {
        const attempt = next[index];
        if (attempt.node_id !== nodeId)
            continue;
        if (attempt.status === "running" || attempt.status === "waiting_user") {
            next[index] = {
                ...attempt,
                status: "waiting_user",
                activations: (attempt.activations ?? []).map((activation) => activation.activation === attempt.activation
                    ? { ...activation, status: "interrupted" }
                    : activation)
            };
            return next;
        }
    }
    return next;
}
async function recoverCheckpointResumeHandoff(
    store: RunStore,
    runId: string,
    state: WorkflowState,
    checkpointResume: NonNullable<ReturnType<typeof resumeFromCheckpoint>>
): Promise<void> {
    checkpointResume.handoff = await recoverLatestIncomingHandoff(store, runId, state, checkpointResume.handoff);
}

function resumeHandoffWithUserInput(handoff: unknown, userInput: unknown, resumed = false): unknown {
    const compacted = compactHandoffForModel(handoff);
    if (isCanonicalHandoff(compacted)) {
        return { ...compacted, ...(resumed ? { resumed: true } : {}), user_input: userInput };
    }
    const previousLayer = compactHandoffLayer(compacted);
    return {
        ...(previousLayer !== undefined ? { previous_handoff: previousLayer } : {}),
        ...(resumed ? { resumed: true } : {}),
        user_input: userInput
    };
}

function isCanonicalHandoff(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const handoff = value as Record<string, unknown>;
    return typeof handoff.to === "string" && typeof handoff.instruction === "string";
}

async function recoverLatestIncomingHandoff(
    store: RunStore,
    runId: string,
    state: WorkflowState,
    checkpointHandoff: unknown
): Promise<unknown> {
    const targetNodeId = state.resume_checkpoint?.node_id;
    if (!targetNodeId) return checkpointHandoff;
    const events = await store.loadEvents(runId);
    let transitionIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === "transition" && event.to === targetNodeId) {
            transitionIndex = index;
            break;
        }
    }
    if (transitionIndex < 0) return checkpointHandoff;
    const transition = events[transitionIndex] as Extract<StoredEvent, { type: "transition" }>;
    for (let index = transitionIndex - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== "node_completed" || event.node_id !== transition.from) continue;
        if (transition.activation !== undefined && event.activation !== transition.activation) continue;
        const parsed = nodeResultSchema.safeParse(event.result);
        if (!parsed.success) return checkpointHandoff;
        const incomingHandoff = buildHandoff(
            targetNodeId,
            transition.from,
            parsed.data,
            latestAttemptForNode(state.attempts, targetNodeId)
        );
        if (sameCanonicalHandoff(checkpointHandoff, incomingHandoff)) return checkpointHandoff;
        return buildResumeHandoff(checkpointHandoff, incomingHandoff);
    }
    return checkpointHandoff;
}

function resumeFromCheckpoint(state: WorkflowState, input: unknown): {
    nodeId: string;
    handoff: unknown;
    attempt: number;
    activation: number;
    dialogueMessages: ModelMessage[];
    dialogueCursor: number;
    userText: string;
} | undefined {
    const checkpoint = state.resume_checkpoint;
    if (!checkpoint || checkpoint.node_id !== state.current_node_id || typeof checkpoint.attempt !== "number" || !Array.isArray(checkpoint.dialogue_messages))
        return undefined;
    const dialogueMessages = [...checkpoint.dialogue_messages];
    const legacyError = legacyRuntimeFailureMessage(state, checkpoint.node_id, checkpoint.attempt);
    if (legacyError && !dialogueMessages.some((message) => message.role === "assistant" && message.is_error === true)) {
        dialogueMessages.push({ role: "assistant", content: legacyError, is_error: true });
    }
    const userMessage = userInputModelMessage(input);
    const userText = userMessageText(input);
    return {
        nodeId: checkpoint.node_id,
        handoff: checkpoint.handoff,
        attempt: checkpoint.attempt,
        activation: (checkpoint.activation ?? 0) + 1,
        dialogueMessages: [...dialogueMessages, userMessage],
        dialogueCursor: checkpoint.dialogue_cursor ?? dialogueMessages.length,
        userText
    };
}

function legacyRuntimeFailureMessage(state: WorkflowState, nodeId: string, attempt: number): string | undefined {
    const failed = [...state.attempts].reverse().find((item) =>
        item.node_id === nodeId && item.attempt === attempt && item.status === "failure"
    );
    if (!failed?.result || typeof failed.result !== "object") return undefined;
    const result = failed.result as Record<string, unknown>;
    const handoff = result.handoff as Record<string, unknown> | undefined;
    if (handoff?.instruction !== "等待用户处理节点失败后继续执行。") return undefined;
    const feedback = result.feedback as Record<string, unknown> | undefined;
    const defects = feedback?.defects;
    if (Array.isArray(defects) && typeof defects[0] === "string" && defects[0].trim()) return defects[0];
    return typeof result.summary === "string" && result.summary.trim() ? result.summary : undefined;
}
function latestAttemptForNode(attempts: WorkflowState["attempts"], nodeId: string): number {
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
        const attempt = attempts[index];
        if (attempt.node_id === nodeId)
            return attempt.attempt;
    }
    return 1;
}
function latestActivationForNode(attempts: WorkflowState["attempts"], nodeId: string): number {
    const index = findLatestAttemptIndex(attempts, nodeId);
    return index >= 0 ? attempts[index]!.activation ?? 1 : 1;
}
function findLatestAttemptIndex(attempts: WorkflowState["attempts"], nodeId: string): number {
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
        if (attempts[index]!.node_id === nodeId) return index;
    }
    return -1;
}
function setAttemptOutcome(
    attempts: WorkflowState["attempts"],
    attemptIndex: number,
    activation: number,
    status: WorkflowState["attempts"][number]["status"],
    activationStatus: NonNullable<WorkflowState["attempts"][number]["activations"]>[number]["status"],
    result: unknown
): void {
    const previous = attempts[attemptIndex];
    if (!previous) return;
    attempts[attemptIndex] = {
        ...previous,
        activation,
        status,
        result,
        activations: (previous.activations ?? []).map((item) => item.activation === activation
            ? { ...item, status: activationStatus, result }
            : item)
    };
}
function controllerReturnMessage(fromNodeId: string, result: NodeResult, handoff: unknown): ModelMessage {
    return {
        role: "user",
        metadata: { userMessageKind: "runtime_context", durableRuntimeContext: true },
        content: JSON.stringify({
            type: "node_transition_result",
            from_node_id: fromNodeId,
            direction: result.direction,
            handoff
        }, null, 2)
    };
}
export function workflowConfigFingerprint(config: AgentTeamConfig, workflowId: string): string {
    const workflow = config.workflows[workflowId];
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);
    const roleIds = [...new Set(workflow.nodes.map((node) => node.role))].sort();
    const material = {
        workflow,
        roles: Object.fromEntries(roleIds.map((roleId) => [roleId, config.roles[roleId]])),
        global_prompt: config.global_prompt ?? ""
    };
    return createHash("sha256").update(stableJson(material)).digest("hex");
}
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
function reworkLimitQuestions(limit: number): NodeResult["questions"] {
    return [{
        id: "rework_limit",
        text: `工作流已达到 ${limit} 次节点返工或重试上限。是否允许本次操作并将本次运行上限增加 ${limit} 次？`,
        required: true,
        allow_freeform: false,
        options: [
            { label: "继续执行", value: "continue", description: `批准本次返工或重试并增加 ${limit} 次额度` },
            { label: "终止工作流", value: "cancel", description: "取消待处理退回并终止本次运行" }
        ]
    }];
}
function continuationStateFields(options: ContinueOptions, checkpoint: WorkflowState["resume_checkpoint"]) {
    const nodeCheckpoints = { ...options.nodeCheckpoints };
    if (checkpoint) nodeCheckpoints[checkpoint.node_id] = checkpoint;
    return {
        version: 5 as const,
        config_fingerprint: options.configFingerprint ?? workflowConfigFingerprint(options.config, options.workflowId),
        node_checkpoints: nodeCheckpoints,
        suspended_stack: [...options.suspendedStack ?? []],
        rework_count: options.reworkCount ?? 0,
        rework_limit: options.reworkLimit ?? options.workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES
    };
}
type ReworkLimitResolution =
  | { type: "cancel"; state: WorkflowState }
  | { type: "continue"; state: WorkflowState; targetNodeId: string; handoff: unknown; resume?: ContinueOptions["resume"]; fromNodeId: string; activation: number; reason: "backward" | "retry" };
function resolveReworkLimitInput(state: WorkflowState, workflow: WorkflowConfig, input: unknown): ReworkLimitResolution | undefined {
    if (state.pending_interaction?.type !== "rework_limit" || !state.current_node_id || !state.resume_checkpoint) return undefined;
    const decision = reworkDecision(input);
    if (!decision) throw new Error("Rework limit resolution must be continue or cancel");
    if (decision === "cancel") {
        return { type: "cancel", state: { ...state, status: "cancelled", pending_interaction: undefined } };
    }
    const result = state.pending_interaction.result as NodeResult;
    if (!result || (result.direction !== "backward" && result.direction !== "retry")) throw new Error("Saved rework transition result is invalid");
    const controller = new NodeTransitionController();
    const resolved = controller.resolve({
        workflow,
        nodeId: state.current_node_id,
        result,
        suspendedStack: state.suspended_stack ?? [],
        reworkCount: state.rework_count ?? 0,
        reworkLimit: state.rework_limit ?? workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES,
        bypassReworkLimit: true
    });
    if (resolved.type !== "node") throw new Error("Approved rework did not resolve to a workflow node");
    const attempts = state.attempts.map((attempt) => ({ ...attempt, activations: [...attempt.activations ?? []] }));
    const attemptIndex = findLatestAttemptIndex(attempts, state.current_node_id);
    const activation = state.resume_checkpoint.activation ?? latestActivationForNode(attempts, state.current_node_id);
    if (attemptIndex >= 0) {
        setAttemptOutcome(attempts, attemptIndex, activation, result.direction === "retry" ? "running" : "suspended", result.direction === "retry" ? "retrying" : "returned", result);
    }
    const nodeCheckpoints = { ...state.node_checkpoints, [state.current_node_id]: state.resume_checkpoint };
    const targetHandoff = buildHandoff(resolved.target_node_id, state.current_node_id, result, 1);
    const savedTarget = nodeCheckpoints[resolved.target_node_id];
    const resumedHandoff = savedTarget ? buildResumeHandoff(savedTarget.handoff, targetHandoff) : undefined;
    const resume = savedTarget ? {
        nodeId: resolved.target_node_id,
        attempt: savedTarget.attempt ?? 1,
        activation: (savedTarget.activation ?? 0) + 1,
        handoff: resumedHandoff,
        dialogueMessages: [...savedTarget.dialogue_messages ?? [], controllerReturnMessage(state.current_node_id, result, targetHandoff)],
        dialogueCursor: savedTarget.dialogue_cursor
    } : undefined;
    const handoff = resumedHandoff ?? targetHandoff;
    const checkpoint = resume
        ? { node_id: resolved.target_node_id, handoff, attempt: resume.attempt, activation: resume.activation ?? 1, dialogue_cursor: resume.dialogueCursor, dialogue_messages: resume.dialogueMessages }
        : { node_id: resolved.target_node_id, handoff, attempt: 1, activation: 1, dialogue_cursor: 0, dialogue_messages: [] };
    nodeCheckpoints[resolved.target_node_id] = checkpoint;
    const extension = workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES;
    const nextState: WorkflowState = {
        ...state,
        version: 5,
        status: "running",
        current_node_id: resolved.target_node_id,
        attempts,
        handoff,
        resume_checkpoint: checkpoint,
        node_checkpoints: nodeCheckpoints,
        suspended_stack: resolved.suspended_stack,
        rework_count: resolved.rework_count,
        rework_limit: (state.rework_limit ?? extension) + extension,
        pending_interaction: undefined
    };
    return { type: "continue", state: nextState, targetNodeId: resolved.target_node_id, handoff, resume, fromNodeId: state.current_node_id, activation, reason: result.direction };
}
// Searching the whole payload for a keyword made "continue, don't cancel" resolve to cancel and
// irreversibly kill the run, so the decision must come from the start of the user's own answer.
function reworkDecision(input: unknown): "continue" | "cancel" | undefined {
    const explicit = input && typeof input === "object" ? (input as { decision?: unknown }).decision : undefined;
    const text = (typeof explicit === "string" ? explicit : userMessageText(input) ?? "").trim().toLowerCase();
    if (/^(cancel|终止|取消)/.test(text)) return "cancel";
    if (/^(continue|继续)/.test(text)) return "continue";
    return undefined;
}
function userInputModelMessage(input: unknown): ModelMessage {
    const text = userMessageText(input);
    const value = input && typeof input === "object" && !Array.isArray(input)
        ? input as { images?: unknown }
        : undefined;
    const images = Array.isArray(value?.images)
        ? value.images.filter((image): image is Extract<ModelContentPart, { type: "image" }> => {
            if (!image || typeof image !== "object") return false;
            const candidate = image as { type?: unknown; media_type?: unknown; data?: unknown };
            return candidate.type === "image"
                && (candidate.media_type === "image/png" || candidate.media_type === "image/jpeg" || candidate.media_type === "image/webp")
                && typeof candidate.data === "string";
        })
        : [];
    return {
        role: "user",
        content: images.length ? [{ type: "text", text: text || "See attached image." }, ...images] : text,
        metadata: { userMessageKind: "human" }
    };
}

function userMessageText(input: unknown): string {
    if (typeof input === "string")
        return input;
    if (input && typeof input === "object") {
        const value = input as Record<string, unknown>;
        if (typeof value.answer === "string")
            return value.answer;
        if (typeof value.request === "string")
            return value.request;
    }
    // JSON.stringify(undefined) is undefined, not a string, and every caller here treats the
    // result as one.
    return JSON.stringify(input) ?? "";
}

import { createHash } from "node:crypto";
import { AgentTeamConfig, DEFAULT_MAX_REWORK_CYCLES, PermissionSet, permissionSetSchema, WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";
import { handoffHasImages } from "../harness/context.js";
import { HarnessEvent, StoredEvent } from "../harness/events.js";
import { EventStream } from "../harness/eventStream.js";
import { mergePermissions } from "../harness/permissions.js";
import { PermissionController } from "../harness/permissionController.js";
import { RuntimeInteraction, runNode } from "../harness/runtime.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import { ModelMessage, ModelProvider } from "../providers/types.js";
import { getProviderMaxOutputTokens, modelRegistryFromProviderConfig } from "../model/modelRegistry.js";
import { resolveEffortForWorkflowNode, resolveModelForWorkflowNode } from "../model/modelRouting.js";
import { formatRunError } from "../runtime/errorFormatting.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { RunStore, RunSummary } from "../storage/runStore.js";
import { prepareProjectStorage, type ProjectStorageContext } from "../storage/projectStorage.js";
import { buildHandoff } from "../team/handoff.js";
import type { PlanRequestedPermission } from "../plans/planSession.js";
import { stripInternalPlanModeHandoffMarkers } from "../plans/planSession.js";
import { NodeResult } from "../team/nodeResult.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { SkillRuntime } from "../skills/runtime.js";
import { createLocalToolRegistry } from "../tools/registry.js";
import { WorkflowState } from "./state.js";
import { WorkflowSession } from "./session.js";
import { firstNodeId } from "./transitions.js";
import { NodeTransitionController } from "./nodeTransitionController.js";
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
    abortSignal?: AbortSignal;
    isInterrupted?: () => boolean;
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
export type WorkflowRunOptions = {
    permissionMode?: WorkflowRunPermissionMode;
    clearContext?: boolean;
    sessionId?: string;
};
export class WorkflowEngine {
    private readonly transitionController = new NodeTransitionController();
    private preparedProjectStorage?: Promise<ProjectStorageContext>;
    constructor(private readonly options: WorkflowEngineOptions) {
        if (options.projectStorage && options.runRoot) {
            throw new Error("WorkflowEngine options projectStorage and runRoot are mutually exclusive");
        }
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
            startNodeId: firstNodeId(workflow),
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
            return this.continueFrom({
                config,
                workflowId,
                workflow,
                store,
                runId,
                startNodeId: state.current_node_id,
                initialHandoff: { previous_handoff: state.handoff, user_input: userInput },
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
        return this.continueFrom({
            config,
            workflowId,
            workflow,
            store,
            runId,
            startNodeId: state.resume_checkpoint.node_id,
            initialHandoff: { previous_handoff: state.resume_checkpoint.handoff, resumed: true, user_input: userInput },
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
    async resumeInteractive(config: AgentTeamConfig, runId: string): Promise<WorkflowSession> {
        const store = await this.runStore();
        const state = await store.loadState(runId);
        const workflowId = state.workflow_id;
        const workflow = config.workflows[workflowId];
        if (!workflow)
            throw new Error(`Unknown workflow ${workflowId}`);
        const stream = new EventStream<StoredEvent>();
        for (const event of await store.loadEvents(runId)) {
            stream.push(event);
        }
        const permissions = new PermissionController();
        let interrupted = false;
        let resultSettled = false;
        let activeRun: Promise<WorkflowState> | undefined;
        let activeAbortController: AbortController | undefined;
        let latestState: WorkflowState = state;
        let resolveResult!: (state: WorkflowState) => void;
        let rejectResult!: (error: unknown) => void;
        const result = new Promise<WorkflowState>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        const finish = (nextState: WorkflowState) => {
            latestState = nextState;
            if (!resultSettled) {
                resultSettled = true;
                resolveResult(nextState);
            }
            stream.end();
        };
        const fail = async (error: unknown) => {
            const formatted = formatRunError(error);
            const failedState: WorkflowState = { ...latestState, status: "paused" };
            latestState = failedState;
            await store.saveState(runId, failedState);
            await this.appendEvent(store, runId, { type: "run_failed", error: formatted.message, ...(formatted.detail ? { detail: formatted.detail } : {}) }, (event) => stream.push(event));
            if (!resultSettled) {
                resultSettled = true;
                rejectResult(error);
            }
            stream.end();
        };
        const finishWhenTerminal = (nextState: WorkflowState) => {
            latestState = nextState;
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
                abortSignal: abortController.signal,
                isInterrupted: () => interrupted,
                onState: (next) => {
                    latestState = next;
                }
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
            permissions.resolveAll("deny_once");
            activeAbortController?.abort();
            if (activeRun) {
                latestState = await activeRun;
                return;
            }
            const waitingState = await this.pauseStateForUser({
                store,
                runId,
                workflowId,
                latestState,
                reason: "用户已暂停当前节点，请输入下一步处理方式。",
                eventSink: (event) => stream.push(event)
            });
            latestState = waitingState;
        };
        if (state.status === "running") {
            queueMicrotask(() => {
                void interruptRun().catch((error) => {
                    void fail(error);
                });
            });
        }
        else if (state.status === "completed") {
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
        return {
            sessionId: (await store.metadata(runId)).sessionId,
            runId,
            state: latestState,
            events: stream,
            permissions,
            interrupt: interruptRun,
            resumeWithUserInput: (input) => withRunLease(async () => {
                if (activeRun)
                    await activeRun;
                if (latestState.status !== "waiting_user" && latestState.status !== "paused")
                    throw new Error(`Run ${runId} is not waiting for user input`);
                if (!latestState.current_node_id)
                    throw new Error(`Run ${runId} has no current node`);
                interrupted = false;
                stream.reopen();
                const guarded = resolveReworkLimitInput(latestState, workflow, input);
                if (guarded) {
                    latestState = guarded.state;
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
                const nextState = await runSegment({
                    startNodeId: latestState.current_node_id,
                    initialHandoff: { previous_handoff: latestState.handoff, user_input: input },
                    attempts: latestState.attempts
                });
                finishWhenTerminal(nextState);
            }),
            continueWithInput: (input) => {
                stream.reopen();
                return withRunLease(async () => {
                    if (activeRun)
                        await activeRun;
                    if (latestState.status === "running" || latestState.status === "waiting_user" || latestState.status === "paused") {
                        throw new Error(`Run ${runId} is not paused`);
                    }
                    interrupted = false;
                    if (latestState.resume_checkpoint) {
                        const checkpointResume = resumeFromCheckpoint(latestState, input);
                        if (checkpointResume) {
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
                        const nextState = await runSegment({
                            startNodeId: checkpoint.node_id,
                            initialHandoff: { previous_handoff: checkpoint.handoff, resumed: true, user_input: input },
                            attempts: latestState.attempts
                        });
                        finishWhenTerminal(nextState);
                        return;
                    }
                    const initialHandoff = await this.prepareInitialHandoff(input, store.runDir(runId));
                    await this.appendEvent(store, runId, { type: "run_continued", workflow_id: workflowId, input: publicWorkflowInput(input) }, (event) => stream.push(event));
                    const nextState = await runSegment({
                        startNodeId: firstNodeId(workflow),
                        initialHandoff,
                        attempts: latestState.attempts
                    });
                    finishWhenTerminal(nextState);
                });
            },
            result
        };
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
        const startNodeId = firstNodeId(workflow);
        const runPermissionMode = options.permissionMode;
        let interrupted = false;
        let resultSettled = false;
        let activeRun: Promise<WorkflowState> | undefined;
        let activeAbortController: AbortController | undefined;
        let latestState: WorkflowState = {
            version: 4,
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
        let resolveResult!: (state: WorkflowState) => void;
        let rejectResult!: (error: unknown) => void;
        const result = new Promise<WorkflowState>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        const finish = (state: WorkflowState) => {
            latestState = state;
            if (!resultSettled) {
                resultSettled = true;
                resolveResult(state);
            }
            stream.end();
        };
        const fail = async (error: unknown) => {
            const formatted = formatRunError(error);
            const failedState: WorkflowState = { ...latestState, status: "paused" };
            latestState = failedState;
            await store.saveState(run.runId, failedState);
            await this.appendEvent(store, run.runId, { type: "run_failed", error: formatted.message, ...(formatted.detail ? { detail: formatted.detail } : {}) }, (event) => stream.push(event));
            if (!resultSettled) {
                resultSettled = true;
                rejectResult(error);
            }
            stream.end();
        };
        const finishWhenTerminal = (state: WorkflowState) => {
            latestState = state;
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
                runPermissionMode,
                planRequestedPermissionRules: latestState.plan_requested_permission_rules,
                eventSink: (event) => stream.push(event),
                interaction: {
                    requestPermission: (request) => permissions.request(request)
                },
                abortSignal: abortController.signal,
                isInterrupted: () => interrupted,
                onState: (state) => {
                    latestState = state;
                }
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
        return {
            sessionId: run.sessionId,
            runId: run.runId,
            state: latestState,
            events: stream,
            permissions,
            interrupt: async () => {
                if ((resultSettled && !activeRun) || interrupted)
                    return;
                interrupted = true;
                permissions.resolveAll("deny_once");
                activeAbortController?.abort();
                if (activeRun) {
                    latestState = await activeRun;
                    return;
                }
                const state = await this.pauseStateForUser({
                    store,
                    runId: run.runId,
                    workflowId,
                    latestState,
                    reason: "用户已暂停当前节点，请输入下一步处理方式。",
                    eventSink: (event) => stream.push(event)
                });
                latestState = state;
            },
            resumeWithUserInput: (input) => withRunLease(async () => {
                if (activeRun)
                    await activeRun;
                if (latestState.status !== "waiting_user" && latestState.status !== "paused")
                    throw new Error(`Run ${run.runId} is not waiting for user input`);
                if (!latestState.current_node_id)
                    throw new Error(`Run ${run.runId} has no current node`);
                interrupted = false;
                stream.reopen();
                const guarded = resolveReworkLimitInput(latestState, workflow, input);
                if (guarded) {
                    latestState = guarded.state;
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
                const state = await runSegment({
                    startNodeId: latestState.current_node_id,
                    initialHandoff: { previous_handoff: latestState.handoff, user_input: input },
                    attempts: latestState.attempts
                });
                finishWhenTerminal(state);
            }),
            continueWithInput: (input) => {
                stream.reopen();
                return withRunLease(async () => {
                    if (activeRun)
                        await activeRun;
                    if (latestState.status === "running" || latestState.status === "waiting_user" || latestState.status === "paused") {
                        throw new Error(`Run ${run.runId} is not paused`);
                    }
                    interrupted = false;
                    if (latestState.resume_checkpoint) {
                        const checkpointResume = resumeFromCheckpoint(latestState, input);
                        if (checkpointResume) {
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
                        const state = await runSegment({
                            startNodeId: checkpoint.node_id,
                            initialHandoff: { previous_handoff: checkpoint.handoff, resumed: true, user_input: input },
                            attempts: latestState.attempts
                        });
                        finishWhenTerminal(state);
                        return;
                    }
                    const initialHandoff = await this.prepareInitialHandoff(input, run.runDir);
                    await this.appendEvent(store, run.runId, { type: "run_continued", workflow_id: workflowId, input: publicWorkflowInput(input) }, (event) => stream.push(event));
                    const state = await runSegment({
                        startNodeId,
                        initialHandoff,
                        attempts: latestState.attempts
                    });
                    finishWhenTerminal(state);
                });
            },
            result
        };
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
            version: 4 as const,
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
            if (options.isInterrupted?.()) {
                return this.pauseNodeForUser(options, currentId, attempts, handoff, "用户已暂停当前节点，请输入下一步处理方式。");
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
            const tools = createLocalToolRegistry({ mcpRuntime: this.options.mcpRuntime, skillRuntime: this.options.skillRuntime });
            let result: NodeResult;
            try {
                result = await runNode({
                    node,
                    navigation: this.transitionController.navigation(options.workflow, node.id),
                    systemPrompt: effectiveSystemPrompt(options.config.global_prompt, role.system_prompt),
                    model: resolveModelForWorkflowNode({ node, role, provider: providerConfig, permissionMode: effectivePermissionMode, planModel: providerConfig.plan_model, registry: modelRegistryFromProviderConfig(providerConfig) }),
                    effort: resolveEffortForWorkflowNode({ node, provider: providerConfig }),
                    modelRegistry: modelRegistryFromProviderConfig(providerConfig),
                    maxOutputTokens: getProviderMaxOutputTokens(providerConfig),
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
                syncOptions();
                if (options.isInterrupted?.() || options.abortSignal?.aborted) {
                    return this.pauseNodeForUser(options, node.id, attempts, handoff, "用户已暂停当前节点，请输入下一步处理方式。", checkpoint());
                }
                return this.failNodeForUser(options, node.id, attempt, attempts, handoff, error, checkpoint());
            }
            if (options.isInterrupted?.()) {
                syncOptions();
                return this.pauseNodeForUser(options, node.id, attempts, handoff, "用户已暂停当前节点，请输入下一步处理方式。", checkpoint());
            }
            try {
                result = await this.ensureNodeDeliverable(options, node.id, attempt, result, activation);
                const resolution = this.transitionController.resolve({
                    workflow: options.workflow,
                    nodeId: node.id,
                    result,
                    suspendedStack,
                    reworkCount,
                    reworkLimit
                });
                const currentCheckpoint = checkpoint();
                if (resolution.type === "user" || resolution.type === "rework_limit") {
                    const questions = resolution.type === "user" ? result.questions : reworkLimitQuestions(reworkLimit);
                    setAttemptOutcome(attempts, attemptIndex, activation, "waiting_user", "waiting_user", result);
                    const pendingInteraction = resolution.type === "user"
                        ? { type: "node_user" as const, node_id: node.id, questions }
                        : { type: "rework_limit" as const, node_id: node.id, questions, result };
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
                    const document = node.mode === "complete" ? requireDocument(node, result) : result.document.trim();
                    setAttemptOutcome(attempts, attemptIndex, activation, "completed", "forwarded", result);
                    if (document) await this.appendEvent(options.store, options.runId, { type: "complete_summary_available", node_id: node.id, attempt, activation, document }, options.eventSink);
                    await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: node.id, attempt, activation, status: "completed", result }, options.eventSink);
                    const finalState: WorkflowState = {
                        status: "completed",
                        ...stateBase(),
                        current_node_id: node.id,
                        attempts,
                        handoff,
                        resume_checkpoint: currentCheckpoint
                    };
                    options.onState?.(finalState);
                    await options.store.saveState(options.runId, finalState);
                    await this.appendEvent(options.store, options.runId, { type: "run_completed", result: { status: finalState.status, workflow_id: finalState.workflow_id } }, options.eventSink);
                    return finalState;
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
                    const resumedMessages = [...savedTarget.dialogue_messages ?? [], controllerReturnMessage(node.id, result, targetHandoff)];
                    const resumedAttempt = savedTarget.attempt ?? 1;
                    const resumedCursor = await options.store.syncWorkflowDialogue(options.runId, target, resumedAttempt, resumedMessages);
                    pendingResume = {
                        nodeId: target,
                        attempt: resumedAttempt,
                        activation: (savedTarget.activation ?? 0) + 1,
                        handoff: savedTarget.handoff,
                        dialogueMessages: resumedMessages,
                        dialogueCursor: resumedCursor
                    };
                    handoff = result.direction === "retry" ? targetHandoff : savedTarget.handoff;
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
                if (options.isInterrupted?.() || options.abortSignal?.aborted) {
                    return this.pauseNodeForUser(options, node.id, attempts, handoff, "用户已暂停当前节点，请输入下一步处理方式。", checkpoint());
                }
                return this.failNodeForUser(options, node.id, attempt, attempts, handoff, error, checkpoint());
            }
        }
        return { status: "completed", ...stateBase(), attempts, handoff };
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
    private async pauseNodeForUser(options: ContinueOptions, nodeId: string, attempts: WorkflowState["attempts"], handoff: unknown, reason: string, resumeCheckpoint?: WorkflowState["resume_checkpoint"]): Promise<WorkflowState> {
        const updatedAttempts = markLatestActiveAttemptWaiting(attempts, nodeId);
        const questions = waitingQuestions(reason);
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
        reason: string;
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
        const questions = waitingQuestions(input.reason);
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
        let handoff = options.clearContext === true ? clearContextPlanHandoff(input) : input;
        const images = (handoff as {
            images?: unknown;
        }).images;
        if (!Array.isArray(images) || !images.length)
            return handoff;
        const artifacts = new ArtifactStore(runDir);
        const refs = [];
        for (const image of images) {
            if (typeof image !== "string")
                continue;
            const ref = await artifacts.copyInputImage(image);
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
    return permissions
        .filter((permission) => permission.tool === "Bash" && permission.prompt.trim())
        .map((permission) => `Bash(prompt:${permission.prompt.replace(/[()]/g, " ").trim()})`);
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
        questions: waitingQuestions(`节点无法继续执行：${formatted.message}

请说明下一步处理方式，或输入重试要求。`),
        handoff: {
            instruction: "等待用户处理节点失败后继续执行。",
            must_follow: [],
            known_risks: [detail],
            open_questions: []
        }
    };
}
function waitingQuestions(text: string): NodeResult["questions"] {
    return [{ id: "next_step", text, required: true }];
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
function requireDocument(node: WorkflowNodeConfig, result: NodeResult): string {
    const document = result.document?.trim();
    if (!document)
        throw new Error(`${node.mode} node ${node.id} must return document`);
    return document;
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
    const userText = userMessageText(input);
    return {
        nodeId: checkpoint.node_id,
        handoff: checkpoint.handoff,
        attempt: checkpoint.attempt,
        activation: (checkpoint.activation ?? 0) + 1,
        dialogueMessages: [...dialogueMessages, { role: "user", content: userText }],
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
        version: 4 as const,
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
    const resume = savedTarget ? {
        nodeId: resolved.target_node_id,
        attempt: savedTarget.attempt ?? 1,
        activation: (savedTarget.activation ?? 0) + 1,
        handoff: savedTarget.handoff,
        dialogueMessages: [...savedTarget.dialogue_messages ?? [], controllerReturnMessage(state.current_node_id, result, targetHandoff)],
        dialogueCursor: savedTarget.dialogue_cursor
    } : undefined;
    const handoff = resume ? (result.direction === "retry" ? targetHandoff : savedTarget!.handoff) : targetHandoff;
    const checkpoint = resume
        ? { node_id: resolved.target_node_id, handoff, attempt: resume.attempt, activation: resume.activation ?? 1, dialogue_cursor: resume.dialogueCursor, dialogue_messages: resume.dialogueMessages }
        : { node_id: resolved.target_node_id, handoff, attempt: 1, activation: 1, dialogue_cursor: 0, dialogue_messages: [] };
    nodeCheckpoints[resolved.target_node_id] = checkpoint;
    const extension = workflow.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES;
    const nextState: WorkflowState = {
        ...state,
        version: 4,
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
function reworkDecision(input: unknown): "continue" | "cancel" | undefined {
    const value = JSON.stringify(input).toLowerCase();
    if (value.includes("cancel") || value.includes("终止")) return "cancel";
    if (value.includes("continue") || value.includes("继续")) return "continue";
    return undefined;
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
    return JSON.stringify(input);
}

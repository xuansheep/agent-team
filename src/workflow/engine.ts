import { access } from "node:fs/promises";

import { join } from "node:path";

import { AgentTeamConfig, PermissionSet, permissionSetSchema, WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";

import { handoffHasImages } from "../harness/context.js";

import { HarnessEvent, StoredEvent } from "../harness/events.js";

import { EventStream } from "../harness/eventStream.js";

import { mergePermissions } from "../harness/permissions.js";

import { PermissionController } from "../harness/permissionController.js";

import { RuntimeInteraction, runNode } from "../harness/runtime.js";
import { WorkflowBackend } from "../kernel/workflow/workflowBackend.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";

import { ModelMessage, ModelProvider } from "../providers/types.js";
import { modelRegistryFromProviderConfig } from "../model/modelRegistry.js";
import { resolveModelForWorkflowNode } from "../model/modelRouting.js";

import { ArtifactStore } from "../storage/artifacts.js";

import { RunStore, RunSummary } from "../storage/runStore.js";

import { buildHandoff } from "../team/handoff.js";
import type { PlanRequestedPermission } from "../plans/planSession.js";
import { stripInternalPlanModeHandoffMarkers } from "../plans/planSession.js";

import { NodeResult } from "../team/nodeResult.js";

import { createLocalToolRegistry } from "../tools/registry.js";

import { WorkflowState } from "./state.js";

import { WorkflowSession } from "./session.js";

import { firstNodeId, nextNodeId } from "./transitions.js";

export type WorkflowEngineOptions = {

    providerFactory: (providerId: string) => ModelProvider;

    cwd: string;

    runRoot?: string;

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

    eventSink?: (event: StoredEvent) => void;

    interaction?: RuntimeInteraction;

    isInterrupted?: () => boolean;

    onState?: (state: WorkflowState) => void;

    resume?: {

        nodeId: string;

        attempt: number;

        dialogueMessages: ModelMessage[];

    };

    runPermissionMode?: WorkflowRunPermissionMode;

    planRequestedPermissionRules?: string[];

};

export type WorkflowRunPermissionMode = Exclude<PermissionMode, "plan">;

export type WorkflowRunOptions = {
    permissionMode?: WorkflowRunPermissionMode;
    clearContext?: boolean;
};

export class WorkflowEngine {

    constructor(private readonly options: WorkflowEngineOptions) { }

    async run(config: AgentTeamConfig, workflowId: string, input: unknown, options: WorkflowRunOptions = {}): Promise<WorkflowState> {

        assertWorkflowRunPermissionMode(options.permissionMode);

        const workflow = config.workflows[workflowId];

        if (!workflow)

            throw new Error(`Unknown workflow ${workflowId}`);

        const store = new RunStore(this.options.runRoot ?? ".session");

        const run = await store.createRun(workflowId, publicWorkflowInput(input));

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

        const store = new RunStore(this.options.runRoot ?? ".session");

        const state = await store.loadState(runId);

        if (state.status === "pending") {

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

            runPermissionMode: state.run_permission_mode,

            planRequestedPermissionRules: state.plan_requested_permission_rules

        });

    }

    async listRuns(options: {

        limit?: number;

    } = {}): Promise<RunSummary[]> {

        const store = new RunStore(this.options.runRoot ?? ".session");

        return store.listRuns(options);

    }

    async resumeInteractive(config: AgentTeamConfig, runId: string): Promise<WorkflowSession> {

        const store = new RunStore(this.options.runRoot ?? ".session");

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

            const failedState: WorkflowState = { ...latestState, status: "pending" };

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

            if (nextState.status === "completed")

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

            activeRun = this.continueFrom({

                config,

                workflowId,

                workflow,

                store,

                runId,

                startNodeId: segment.startNodeId,

                initialHandoff: segment.initialHandoff,

                attempts: segment.attempts,

                resume: segment.resume,

                runPermissionMode: latestState.run_permission_mode,

                planRequestedPermissionRules: latestState.plan_requested_permission_rules,

                eventSink: (event) => stream.push(event),

                interaction: {

                    requestPermission: (request) => permissions.request(request)

                },

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

                activeRun = undefined;

            }

        };

        const interruptRun = async () => {

            if ((resultSettled && !activeRun) || interrupted)

                return;

            interrupted = true;

            permissions.resolveAll("deny_once");

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

        return {

            runId,

            state: latestState,

            events: stream,

            permissions,

            interrupt: interruptRun,

            resumeWithUserInput: async (input) => {

                if (activeRun)

                    await activeRun;

                if (latestState.status !== "pending")

                    throw new Error(`Run ${runId} is not waiting for user input`);

                if (!latestState.current_node_id)

                    throw new Error(`Run ${runId} has no current node`);

                interrupted = false;

                stream.reopen();

                const checkpointResume = resumeFromCheckpoint(latestState, input);

                if (checkpointResume) {

                    await this.appendEvent(store, runId, {

                        type: "user_message",

                        text: checkpointResume.userText,

                        node_id: checkpointResume.nodeId,

                        attempt: checkpointResume.attempt

                    }, (event) => stream.push(event));

                    const nextState = await runSegment({

                        startNodeId: checkpointResume.nodeId,

                        initialHandoff: checkpointResume.handoff,

                        attempts: latestState.attempts,

                        resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, dialogueMessages: checkpointResume.dialogueMessages }

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

            },

            continueWithInput: async (input) => {

                if (activeRun)

                    await activeRun;

                if (latestState.status === "running" || latestState.status === "pending") {

                    throw new Error(`Run ${runId} is not paused`);

                }

                interrupted = false;

                stream.reopen();

                if (latestState.resume_checkpoint) {

                    const checkpointResume = resumeFromCheckpoint(latestState, input);

                    if (checkpointResume) {

                        await this.appendEvent(store, runId, {

                            type: "user_message",

                            text: checkpointResume.userText,

                            node_id: checkpointResume.nodeId,

                            attempt: checkpointResume.attempt

                        }, (event) => stream.push(event));

                        const nextState = await runSegment({

                            startNodeId: checkpointResume.nodeId,

                            initialHandoff: checkpointResume.handoff,

                            attempts: latestState.attempts,

                            resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, dialogueMessages: checkpointResume.dialogueMessages }

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

                await this.appendEvent(store, runId, { type: "run_started", workflow_id: workflowId, input: publicWorkflowInput(input) }, (event) => stream.push(event));

                const nextState = await runSegment({

                    startNodeId: firstNodeId(workflow),

                    initialHandoff,

                    attempts: latestState.attempts

                });

                finishWhenTerminal(nextState);

            },

            result

        };

    }

    async startInteractive(config: AgentTeamConfig, workflowId: string, input: unknown, options: WorkflowRunOptions = {}): Promise<WorkflowSession> {

        assertWorkflowRunPermissionMode(options.permissionMode);

        const workflow = config.workflows[workflowId];

        if (!workflow)

            throw new Error(`Unknown workflow ${workflowId}`);

        const store = new RunStore(this.options.runRoot ?? ".session");

        const run = await store.createRun(workflowId, publicWorkflowInput(input));

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

        let latestState: WorkflowState = {

            status: "running",

            workflow_id: workflowId,

            ...(runPermissionMode ? { run_permission_mode: runPermissionMode } : {}),
            ...(planRequestedPermissionRules.length ? { plan_requested_permission_rules: planRequestedPermissionRules } : {}),

            current_node_id: startNodeId,

            attempts: [],

            handoff: initialHandoff

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

            const failedState: WorkflowState = { ...latestState, status: "pending" };

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

            if (state.status === "completed")

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

            activeRun = this.continueFrom({

                config,

                workflowId,

                workflow,

                store,

                runId: run.runId,

                startNodeId: segment.startNodeId,

                initialHandoff: segment.initialHandoff,

                attempts: segment.attempts,

                resume: segment.resume,

                runPermissionMode,

                planRequestedPermissionRules: latestState.plan_requested_permission_rules,

                eventSink: (event) => stream.push(event),

                interaction: {

                    requestPermission: (request) => permissions.request(request)

                },

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

                activeRun = undefined;

            }

        };

        void runSegment({ startNodeId, initialHandoff, attempts: [] }).catch((error) => {

            void fail(error);

        });

        return {

            runId: run.runId,

            state: latestState,

            events: stream,

            permissions,

            interrupt: async () => {

                if ((resultSettled && !activeRun) || interrupted)

                    return;

                interrupted = true;

                permissions.resolveAll("deny_once");

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

            resumeWithUserInput: async (input) => {

                if (activeRun)

                    await activeRun;

                if (latestState.status !== "pending")

                    throw new Error(`Run ${run.runId} is not waiting for user input`);

                if (!latestState.current_node_id)

                    throw new Error(`Run ${run.runId} has no current node`);

                interrupted = false;

                stream.reopen();

                const checkpointResume = resumeFromCheckpoint(latestState, input);

                if (checkpointResume) {

                    await this.appendEvent(store, run.runId, {

                        type: "user_message",

                        text: checkpointResume.userText,

                        node_id: checkpointResume.nodeId,

                        attempt: checkpointResume.attempt

                    }, (event) => stream.push(event));

                    const state = await runSegment({

                        startNodeId: checkpointResume.nodeId,

                        initialHandoff: checkpointResume.handoff,

                        attempts: latestState.attempts,

                        resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, dialogueMessages: checkpointResume.dialogueMessages }

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

            },

            continueWithInput: async (input) => {

                if (activeRun)

                    await activeRun;

                if (latestState.status === "running" || latestState.status === "pending") {

                    throw new Error(`Run ${run.runId} is not paused`);

                }

                interrupted = false;

                stream.reopen();

                if (latestState.resume_checkpoint) {

                    const checkpointResume = resumeFromCheckpoint(latestState, input);

                    if (checkpointResume) {

                        await this.appendEvent(store, run.runId, {

                            type: "user_message",

                            text: checkpointResume.userText,

                            node_id: checkpointResume.nodeId,

                            attempt: checkpointResume.attempt

                        }, (event) => stream.push(event));

                        const state = await runSegment({

                            startNodeId: checkpointResume.nodeId,

                            initialHandoff: checkpointResume.handoff,

                            attempts: latestState.attempts,

                            resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, dialogueMessages: checkpointResume.dialogueMessages }

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

                await this.appendEvent(store, run.runId, { type: "run_started", workflow_id: workflowId, input: publicWorkflowInput(input) }, (event) => stream.push(event));

                const state = await runSegment({

                    startNodeId,

                    initialHandoff,

                    attempts: latestState.attempts

                });

                finishWhenTerminal(state);

            },

            result

        };

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

        await this.appendEvent(input.store, input.runId, {

            type: "user_message",

            text: checkpointResume.userText,

            node_id: checkpointResume.nodeId,

            attempt: checkpointResume.attempt

        });

        return this.continueFrom({

            config: input.config,

            workflowId: input.workflowId,

            workflow: input.workflow,

            store: input.store,

            runId: input.runId,

            startNodeId: checkpointResume.nodeId,

            initialHandoff: checkpointResume.handoff,

            attempts: input.state.attempts,

            resume: { nodeId: checkpointResume.nodeId, attempt: checkpointResume.attempt, dialogueMessages: checkpointResume.dialogueMessages },

            runPermissionMode: input.state.run_permission_mode,

            planRequestedPermissionRules: input.state.plan_requested_permission_rules

        });

    }

    private async continueFrom(options: ContinueOptions): Promise<WorkflowState> {

        const tools = createLocalToolRegistry();

        const basePermissions = options.workflow.workflow_permissions ?? permissionSetSchema.parse(undefined);
        const planRequestedPermissionRules = options.planRequestedPermissionRules?.length
            ? options.planRequestedPermissionRules
            : planRequestedPermissionRulesFromHandoff(options.initialHandoff);
        options.planRequestedPermissionRules = planRequestedPermissionRules;

        const runPermissionMode = options.runPermissionMode;

        const stateBase = () => ({
            workflow_id: options.workflowId,
            ...(runPermissionMode ? { run_permission_mode: runPermissionMode } : {}),
            ...(planRequestedPermissionRules.length ? { plan_requested_permission_rules: planRequestedPermissionRules } : {})
        });

        const attempts = [...options.attempts];

        let currentId: string | undefined = options.startNodeId;

        let handoff: unknown = options.initialHandoff;

        while (currentId) {

            if (options.isInterrupted?.()) {

                return this.pauseNodeForUser(options, currentId, attempts, handoff, "用户已暂停当前节点，请输入下一步处理方式。");

            }

            const node = options.workflow.nodes.find((item) => item.id === currentId);

            if (!node)

                throw new Error(`Unknown node ${currentId}`);

            const role = options.config.roles[node.role];

            const providerConfig = options.config.providers[node.provider];

            const effectivePermissionMode = runPermissionMode ?? node.permission_mode;

            this.assertCapabilities(node, role.requires, providerConfig.capabilities, handoff);

            const resume = options.resume?.nodeId === node.id ? options.resume : undefined;

            const attempt = resume?.attempt ?? attempts.filter((item) => item.node_id === node.id).length + 1;

            let dialogueMessages = resume?.dialogueMessages ?? [];

            let shouldEmitNodeStarted = !resume;

            if (resume) {

                const attemptIndex = attempts.findIndex((item) => item.node_id === node.id && item.attempt === attempt);

                if (attemptIndex === -1) {

                    attempts.push({ node_id: node.id, attempt, status: "running" });

                    shouldEmitNodeStarted = true;

                }

                else {

                    attempts[attemptIndex] = { ...attempts[attemptIndex], status: "running" };

                }

                options.resume = undefined;

            }

            else {

                attempts.push({ node_id: node.id, attempt, status: "running" });

            }

            const checkpoint = () => ({ node_id: node.id, handoff, attempt, dialogue_messages: dialogueMessages });

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

            if (shouldEmitNodeStarted)

                await this.appendEvent(options.store, options.runId, { type: "node_started", node_id: node.id, attempt }, options.eventSink);

            let result: NodeResult;

            try {

                result = await runNode({

                    node,

                    systemPrompt: effectiveSystemPrompt(options.config.global_prompt, role.system_prompt),

                    model: resolveModelForWorkflowNode({ node, role, provider: providerConfig, permissionMode: effectivePermissionMode, planModel: providerConfig.plan_model, registry: modelRegistryFromProviderConfig(providerConfig) }),

                    provider: this.options.providerFactory(node.provider),

                    tools,

                    permissions: workflowToolPermissions(effectivePermissionMode, basePermissions, node.permissions ?? permissionSetSchema.parse(undefined), planRequestedPermissionRules),

                    cwd: this.options.cwd,

                    runId: options.runId,

                    store: options.store,

                    handoff,

                    attempt,

                    interaction: options.interaction,

                    eventSink: options.eventSink,

                    dialogueMessages,

                    onDialogueMessages: async (messages) => {

                        dialogueMessages = messages;

                        const state: WorkflowState = {

                            status: "running",

                            ...stateBase(),

                            current_node_id: node.id,

                            attempts,

                            handoff,

                            resume_checkpoint: checkpoint()

                        };

                        options.onState?.(state);

                        await options.store.saveState(options.runId, state);

                    }

                });

            }

            catch (error) {

                return this.failNodeForUser(options, node.id, attempt, attempts, handoff, error, checkpoint());

            }

            if (options.isInterrupted?.()) {

                return this.pauseNodeForUser(options, node.id, attempts, handoff, "用户已暂停当前节点，请输入下一步处理方式。", checkpoint());

            }

            try {

                if (node.mode === "complete" && result.status === "success") {

                    requireDocument(node, result);

                }

                result = await this.ensureNodeDeliverable(options, node.id, attempt, result);

                if (result.status === "needs_user_input") {

                    attempts[attempts.length - 1] = { node_id: node.id, attempt, status: "waiting_user", result };

                    await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: node.id, questions: result.questions }, options.eventSink);

                    const state: WorkflowState = {

                        status: "pending",

                        ...stateBase(),

                        current_node_id: node.id,

                        attempts,

                        handoff,

                        resume_checkpoint: checkpoint()

                    };

                    options.onState?.(state);

                    await options.store.saveState(options.runId, state);

                    return state;

                }

                if (node.mode === "complete" && result.status === "success") {

                    const document = requireDocument(node, result);

                    await this.appendEvent(options.store, options.runId, { type: "complete_summary_available", node_id: node.id, attempt, document }, options.eventSink);

                }

                const status = result.status === "success" ? "success" : "failure";

                attempts[attempts.length - 1] = { node_id: node.id, attempt, status, result };

                await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: node.id, status, result }, options.eventSink);

                const next = nextNodeId(options.workflow, node.id, status);

                if (!next) {

                    if (status === "failure") {

                        const questions = result.questions.length ? result.questions : waitingQuestions("节点执行失败且没有可用的失败流转边，请说明下一步处理方式。");

                        const pendingState: WorkflowState = {

                            status: "pending",

                            ...stateBase(),

                            current_node_id: node.id,

                            attempts,

                            handoff,

                            resume_checkpoint: checkpoint()

                        };

                        options.onState?.(pendingState);

                        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: node.id, questions }, options.eventSink);

                        await options.store.saveState(options.runId, pendingState);

                        return pendingState;

                    }

                    const finalState: WorkflowState = { status: "completed", ...stateBase(), attempts, handoff };

                    options.onState?.(finalState);

                    await options.store.saveState(options.runId, finalState);

                    await this.appendEvent(options.store, options.runId, { type: "run_completed", result: finalState }, options.eventSink);

                    return finalState;

                }

                await this.appendEvent(options.store, options.runId, { type: "transition", from: node.id, to: next, reason: status }, options.eventSink);

                handoff = buildHandoff(next, node.id, result, attempts.filter((item) => item.node_id === next).length + 1);

                const transitionState: WorkflowState = {

                    status: "running",

                    ...stateBase(),

                    current_node_id: next,

                    attempts,

                    handoff,

                    resume_checkpoint: { node_id: next, handoff, attempt: attempts.filter((item) => item.node_id === next).length + 1, dialogue_messages: [] }

                };

                options.onState?.(transitionState);

                await options.store.saveState(options.runId, transitionState);

                currentId = next;

            }

            catch (error) {

                return this.failNodeForUser(options, node.id, attempt, attempts, handoff, error, checkpoint());

            }

        }

        return { status: "completed", ...stateBase(), attempts, handoff };

    }

    private async failNodeForUser(options: ContinueOptions, nodeId: string, attempt: number, attempts: WorkflowState["attempts"], handoff: unknown, error: unknown, resumeCheckpoint?: WorkflowState["resume_checkpoint"]): Promise<WorkflowState> {

        const result = await this.ensureNodeDeliverable(options, nodeId, attempt, errorNodeResult(error));

        attempts[attempts.length - 1] = { node_id: nodeId, attempt, status: "failure", result };

        await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: nodeId, status: "failure", result }, options.eventSink);

        const state: WorkflowState = {

            status: "pending",

            workflow_id: options.workflowId,

            ...(options.runPermissionMode ? { run_permission_mode: options.runPermissionMode } : {}),
            ...(options.planRequestedPermissionRules?.length ? { plan_requested_permission_rules: options.planRequestedPermissionRules } : {}),

            current_node_id: nodeId,

            attempts,

            handoff,

            resume_checkpoint: resumeCheckpoint ?? { node_id: nodeId, handoff, attempt, dialogue_messages: [] }

        };

        options.onState?.(state);

        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: nodeId, questions: result.questions }, options.eventSink);

        await options.store.saveState(options.runId, state);

        return state;

    }

    private async pauseNodeForUser(options: ContinueOptions, nodeId: string, attempts: WorkflowState["attempts"], handoff: unknown, reason: string, resumeCheckpoint?: WorkflowState["resume_checkpoint"]): Promise<WorkflowState> {

        const updatedAttempts = markLatestActiveAttemptWaiting(attempts, nodeId);

        const questions = waitingQuestions(reason);

        const state: WorkflowState = {

            status: "pending",

            workflow_id: options.workflowId,

            ...(options.runPermissionMode ? { run_permission_mode: options.runPermissionMode } : {}),
            ...(options.planRequestedPermissionRules?.length ? { plan_requested_permission_rules: options.planRequestedPermissionRules } : {}),

            current_node_id: nodeId,

            attempts: updatedAttempts,

            handoff,

            resume_checkpoint: resumeCheckpoint ?? { node_id: nodeId, handoff, attempt: latestAttemptForNode(updatedAttempts, nodeId), dialogue_messages: [] }

        };

        options.onState?.(state);

        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: nodeId, questions }, options.eventSink);

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

        const checkpoint = input.latestState.resume_checkpoint;

        const handoff = checkpoint?.handoff ?? input.latestState.handoff;

        const attempts = markLatestActiveAttemptWaiting(input.latestState.attempts, nodeId);

        const questions = waitingQuestions(input.reason);

        const state: WorkflowState = {

            ...input.latestState,

            status: "pending",

            current_node_id: nodeId,

            attempts,

            handoff,

            resume_checkpoint: checkpoint ? { ...checkpoint, node_id: nodeId, handoff } : { node_id: nodeId, handoff, attempt: latestAttemptForNode(attempts, nodeId), dialogue_messages: [] }

        };

        await this.appendEvent(input.store, input.runId, { type: "node_waiting_user", node_id: nodeId, questions }, input.eventSink);

        await input.store.saveState(input.runId, state);

        return state;

    }

    private async ensureNodeDeliverable(options: ContinueOptions, nodeId: string, attempt: number, result: NodeResult): Promise<NodeResult> {

        const runDir = options.store.runDir(options.runId);

        const deliverables: NodeResult["deliverables"] = [];

        for (const deliverable of result.deliverables) {

            if (await artifactExists(runDir, nodeId, deliverable.artifact_id))

                deliverables.push(deliverable);

        }

        if (deliverables.length)

            return deliverables.length === result.deliverables.length ? result : { ...result, deliverables };

        const name = `node-output-${attempt}.md`;

        const ref = await new ArtifactStore(runDir).writeText(nodeId, name, nodeDeliverableMarkdown(nodeId, attempt, result));

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

    const parts = artifactId.split(/[\/]/);

    if (parts[0] !== nodeId || parts.length < 2 || parts.some((part) => !part || part === ".."))

        return false;

    try {

        await access(join(runDir, "artifacts", ...parts));

        return true;

    }

    catch {

        return false;

    }

}

function nodeDeliverableMarkdown(nodeId: string, attempt: number, result: NodeResult): string {

    const lines = [`# ${nodeId} attempt ${attempt} output`, "", `- 状态：${result.status}`, `- 摘要：${result.summary || "无"}`];

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

        status: "failure",

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

            next[index] = { ...attempt, status: "waiting_user" };

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

function formatRunError(error: unknown): {

    message: string;

    detail?: string;

} {

    const message = error instanceof Error ? error.message : String(error);

    const detail = [explicitErrorDetail(error), causeErrorDetail(error)].filter(Boolean).join("\n");

    return { message, ...(detail ? { detail } : {}) };

}

function explicitErrorDetail(error: unknown): string | undefined {

    if (!error || typeof error !== "object")

        return undefined;

    const detail = (error as {

        detail?: unknown;

    }).detail;

    return typeof detail === "string" && detail.trim() ? detail : undefined;

}

function causeErrorDetail(error: unknown): string | undefined {

    if (!(error instanceof Error) || !("cause" in error))

        return undefined;

    const cause = (error as {

        cause?: unknown;

    }).cause;

    if (!cause)

        return undefined;

    return errorDetailLines("cause", cause).join("\n");

}

function errorDetailLines(prefix: string, value: unknown): string[] {

    if (value instanceof Error) {

        const code = (value as Error & {

            code?: unknown;

        }).code;

        return [

            `${prefix}.name: ${value.name}`,

            `${prefix}.message: ${value.message}`,

            ...(typeof code === "string" || typeof code === "number" ? [`${prefix}.code: ${String(code)}`] : [])

        ];

    }

    if (value && typeof value === "object") {

        const record = value as Record<string, unknown>;

        return ["name", "message", "code"]

            .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")

            .map((key) => `${prefix}.${key}: ${String(record[key])}`);

    }

    return [`${prefix}.message: ${String(value)}`];

}

function resumeFromCheckpoint(state: WorkflowState, input: unknown): {

    nodeId: string;

    handoff: unknown;

    attempt: number;

    dialogueMessages: ModelMessage[];

    userText: string;

} | undefined {

    const checkpoint = state.resume_checkpoint;

    if (!checkpoint || checkpoint.node_id !== state.current_node_id || typeof checkpoint.attempt !== "number" || !Array.isArray(checkpoint.dialogue_messages))

        return undefined;

    const userText = userMessageText(input);

    return {

        nodeId: checkpoint.node_id,

        handoff: checkpoint.handoff,

        attempt: checkpoint.attempt,

        dialogueMessages: [...checkpoint.dialogue_messages, { role: "user", content: userText }],

        userText

    };

}

function latestAttemptForNode(attempts: WorkflowState["attempts"], nodeId: string): number {

    for (let index = attempts.length - 1; index >= 0; index -= 1) {

        const attempt = attempts[index];

        if (attempt.node_id === nodeId)

            return attempt.attempt;

    }

    return 1;

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

export function createWorkflowBackend(
    engine: WorkflowEngine,
    config: AgentTeamConfig,
    workflowId: string,
    options: WorkflowRunOptions = {}
): WorkflowBackend {
    return new WorkflowBackend({
        startWorkflow: async (handoff) => {
            const session = await engine.startInteractive(config, workflowId, handoff, options);
            return { runId: session.runId, status: session.state.status === "completed" ? "completed" : "running" };
        }
    });
}

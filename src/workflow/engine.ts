import { AgentTeamConfig, permissionSetSchema, WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";


import { handoffHasImages } from "../harness/context.js";


import { HarnessEvent, StoredEvent } from "../harness/events.js";


import { EventStream } from "../harness/eventStream.js";


import { mergePermissions } from "../harness/permissions.js";


import { PermissionController } from "../harness/permissionController.js";


import { RuntimeInteraction, runNode } from "../harness/runtime.js";


import { ModelProvider } from "../providers/types.js";


import { ArtifactStore } from "../storage/artifacts.js";


import { RunStore, RunSummary } from "../storage/runStore.js";


import { buildHandoff } from "../team/handoff.js";


import { NodeResult } from "../team/nodeResult.js";


import { createLocalToolRegistry } from "../tools/registry.js";


import { WorkflowState } from "./state.js";


import { PlanReviewDecision, WorkflowSession } from "./session.js";


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


};





type PlanReviewOptions = Omit<ContinueOptions, "startNodeId" | "initialHandoff" | "attempts"> & {


  state: WorkflowState;


  decision: PlanReviewDecision;


};





export class WorkflowEngine {


  constructor(private readonly options: WorkflowEngineOptions) {}





  async run(config: AgentTeamConfig, workflowId: string, input: unknown): Promise<WorkflowState> {


    const workflow = config.workflows[workflowId];


    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);





    const store = new RunStore(this.options.runRoot ?? ".session");


    const run = await store.createRun(workflowId, input);


    const initialHandoff = await this.prepareInitialHandoff(input, run.runDir);


    return this.continueFrom({


      config,


      workflowId,


      workflow,


      store,


      runId: run.runId,


      startNodeId: firstNodeId(workflow),


      initialHandoff,


      attempts: []


    });


  }





  async resume(config: AgentTeamConfig, workflowId: string, runId: string, userInput: unknown): Promise<WorkflowState> {


    const workflow = config.workflows[workflowId];


    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);


    const store = new RunStore(this.options.runRoot ?? ".session");


    const state = await store.loadState(runId);





    if (state.status === "waiting_plan_review") {


      return this.continuePlanReview({


        config,


        workflowId,


        workflow,


        store,


        runId,


        state,


        decision: planReviewDecisionFromInput(userInput)


      });


    }





    if (state.status === "interrupted") {


      if (!state.current_node_id) throw new Error(`Run ${runId} has no current node`);


      return this.continueFrom({


        config,


        workflowId,


        workflow,


        store,


        runId,


        startNodeId: state.current_node_id,


        initialHandoff: { previous_handoff: state.handoff, interrupted: true, user_input: userInput },


        attempts: state.attempts


      });


    }





    if (state.status !== "waiting_user") throw new Error(`Run ${runId} is not waiting for user input`);


    if (!state.current_node_id) throw new Error(`Run ${runId} has no current node`);





    return this.continueFrom({


      config,


      workflowId,


      workflow,


      store,


      runId,


      startNodeId: state.current_node_id,


      initialHandoff: { previous_handoff: state.handoff, user_input: userInput },


      attempts: state.attempts


    });


  }





  async listRuns(options: { limit?: number } = {}): Promise<RunSummary[]> {


    const store = new RunStore(this.options.runRoot ?? ".session");


    return store.listRuns(options);


  }





  async resumeInteractive(config: AgentTeamConfig, runId: string): Promise<WorkflowSession> {
    const store = new RunStore(this.options.runRoot ?? ".session");
    const state = await store.loadState(runId);
    const workflowId = state.workflow_id;
    const workflow = config.workflows[workflowId];
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);

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
      await this.appendEvent(store, runId, { type: "run_failed", error: formatted.message, ...(formatted.detail ? { detail: formatted.detail } : {}) }, (event) => stream.push(event));
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(error);
      }
      stream.end();
    };

    const finishWhenTerminal = (nextState: WorkflowState) => {
      latestState = nextState;
      if (nextState.status !== "waiting_user" && nextState.status !== "waiting_plan_review") finish(nextState);
    };

    const runSegment = async (segment: { startNodeId: string; initialHandoff: unknown; attempts: WorkflowState["attempts"] }) => {
      if (activeRun) throw new Error(`Run ${runId} is already active`);

      activeRun = this.continueFrom({
        config,
        workflowId,
        workflow,
        store,
        runId,
        startNodeId: segment.startNodeId,
        initialHandoff: segment.initialHandoff,
        attempts: segment.attempts,
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
      } finally {
        activeRun = undefined;
      }
    };

    if (state.status === "completed" || state.status === "failed" || state.status === "interrupted") {
      queueMicrotask(() => finish(state));
    }

    return {
      runId,
      state: latestState,
      events: stream,
      permissions,
      interrupt: async () => {
        if ((resultSettled && !activeRun) || interrupted) return;
        interrupted = true;
        permissions.resolveAll("deny_once");
        let running: WorkflowState["attempts"][number] | undefined;
        for (let index = latestState.attempts.length - 1; index >= 0; index -= 1) {
          const attempt = latestState.attempts[index];
          if (attempt.status === "running" || attempt.status === "waiting_plan_review" || attempt.status === "waiting_user") {
            running = attempt;
            break;
          }
        }
        if (running) {
          await this.appendEvent(store, runId, { type: "node_interrupted", node_id: running.node_id, attempt: running.attempt }, (event) => stream.push(event));
        }
        const interruptedState: WorkflowState = { ...latestState, status: "interrupted" };
        await this.appendEvent(store, runId, { type: "run_interrupted", reason: "user" }, (event) => stream.push(event));
        await store.saveState(runId, interruptedState);
        finish(interruptedState);
      },
      resumeWithUserInput: async (input) => {
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_user") throw new Error(`Run ${runId} is not waiting for user input`);
        if (!latestState.current_node_id) throw new Error(`Run ${runId} has no current node`);

        stream.reopen();
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
      resumePlanReview: async (decision) => {
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_plan_review") throw new Error(`Run ${runId} is not waiting for plan review`);
        stream.reopen();
        const nextState = await this.continuePlanReview({
          config,
          workflowId,
          workflow,
          store,
          runId,
          state: latestState,
          decision,
          eventSink: (event) => stream.push(event),
          interaction: {
            requestPermission: (request) => permissions.request(request)
          },
          isInterrupted: () => interrupted,
          onState: (next) => {
            latestState = next;
          }
        });
        finishWhenTerminal(nextState);
      },
      revisePlan: async (input) => {
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_plan_review") throw new Error(`Run ${runId} is not waiting for plan review`);
        if (!latestState.current_node_id) throw new Error(`Run ${runId} has no current node`);

        stream.reopen();
        await this.appendEvent(store, runId, {
          type: "user_message",
          text: userMessageText(input),
          node_id: latestState.current_node_id,
          attempt: latestState.attempts.filter((attempt) => attempt.node_id === latestState.current_node_id).length + 1
        }, (event) => stream.push(event));
        const nextState = await runSegment({
          startNodeId: latestState.current_node_id,
          initialHandoff: { previous_handoff: latestState.handoff, pending_review: latestState.pending_review, user_input: input },
          attempts: latestState.attempts
        });
        finishWhenTerminal(nextState);
      },
      continueWithInput: async (input) => {
        if (activeRun) await activeRun;
        if (latestState.status === "running" || latestState.status === "waiting_user" || latestState.status === "waiting_plan_review") {
          throw new Error(`Run ${runId} is not paused`);
        }

        interrupted = false;
        stream.reopen();
        const initialHandoff = await this.prepareInitialHandoff(input, store.runDir(runId));
        await this.appendEvent(store, runId, { type: "run_started", workflow_id: workflowId, input }, (event) => stream.push(event));
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

  async startInteractive(config: AgentTeamConfig, workflowId: string, input: unknown): Promise<WorkflowSession> {
    const workflow = config.workflows[workflowId];
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);

    const store = new RunStore(this.options.runRoot ?? ".session");
    const run = await store.createRun(workflowId, input);
    const initialHandoff = await this.prepareInitialHandoff(input, run.runDir);
    const stream = new EventStream<StoredEvent>();
    for (const event of await store.loadEvents(run.runId)) {
      stream.push(event);
    }

    const permissions = new PermissionController();
    const startNodeId = firstNodeId(workflow);
    let interrupted = false;
    let resultSettled = false;
    let activeRun: Promise<WorkflowState> | undefined;
    let latestState: WorkflowState = {
      status: "running",
      workflow_id: workflowId,
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
      await this.appendEvent(store, run.runId, { type: "run_failed", error: formatted.message, ...(formatted.detail ? { detail: formatted.detail } : {}) }, (event) => stream.push(event));
      if (!resultSettled) {
        resultSettled = true;
        rejectResult(error);
      }
      stream.end();
    };

    const finishWhenTerminal = (state: WorkflowState) => {
      latestState = state;
      if (state.status !== "waiting_user" && state.status !== "waiting_plan_review") finish(state);
    };

    const runSegment = async (segment: { startNodeId: string; initialHandoff: unknown; attempts: WorkflowState["attempts"] }) => {
      if (activeRun) throw new Error(`Run ${run.runId} is already active`);

      activeRun = this.continueFrom({
        config,
        workflowId,
        workflow,
        store,
        runId: run.runId,
        startNodeId: segment.startNodeId,
        initialHandoff: segment.initialHandoff,
        attempts: segment.attempts,
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
      } finally {
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
        if ((resultSettled && !activeRun) || interrupted) return;
        interrupted = true;
        permissions.resolveAll("deny_once");
        let running: WorkflowState["attempts"][number] | undefined;
        for (let index = latestState.attempts.length - 1; index >= 0; index -= 1) {
          const attempt = latestState.attempts[index];
          if (attempt.status === "running" || attempt.status === "waiting_plan_review" || attempt.status === "waiting_user") {
            running = attempt;
            break;
          }
        }
        if (running) {
          await this.appendEvent(store, run.runId, { type: "node_interrupted", node_id: running.node_id, attempt: running.attempt }, (event) => stream.push(event));
        }
        const state: WorkflowState = { ...latestState, status: "interrupted" };
        await this.appendEvent(store, run.runId, { type: "run_interrupted", reason: "user" }, (event) => stream.push(event));
        await store.saveState(run.runId, state);
        finish(state);
      },
      resumeWithUserInput: async (input) => {
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_user") throw new Error(`Run ${run.runId} is not waiting for user input`);
        if (!latestState.current_node_id) throw new Error(`Run ${run.runId} has no current node`);

        stream.reopen();
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
      resumePlanReview: async (decision) => {
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_plan_review") throw new Error(`Run ${run.runId} is not waiting for plan review`);
        stream.reopen();
        const state = await this.continuePlanReview({
          config,
          workflowId,
          workflow,
          store,
          runId: run.runId,
          state: latestState,
          decision,
          eventSink: (event) => stream.push(event),
          interaction: {
            requestPermission: (request) => permissions.request(request)
          },
          isInterrupted: () => interrupted,
          onState: (next) => {
            latestState = next;
          }
        });
        finishWhenTerminal(state);
      },
      revisePlan: async (input) => {
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_plan_review") throw new Error(`Run ${run.runId} is not waiting for plan review`);
        if (!latestState.current_node_id) throw new Error(`Run ${run.runId} has no current node`);

        stream.reopen();
        await this.appendEvent(store, run.runId, {
          type: "user_message",
          text: userMessageText(input),
          node_id: latestState.current_node_id,
          attempt: latestState.attempts.filter((attempt) => attempt.node_id === latestState.current_node_id).length + 1
        }, (event) => stream.push(event));
        const state = await runSegment({
          startNodeId: latestState.current_node_id,
          initialHandoff: { previous_handoff: latestState.handoff, pending_review: latestState.pending_review, user_input: input },
          attempts: latestState.attempts
        });
        finishWhenTerminal(state);
      },
      continueWithInput: async (input) => {
        if (activeRun) await activeRun;
        if (latestState.status === "running" || latestState.status === "waiting_user" || latestState.status === "waiting_plan_review") {
          throw new Error(`Run ${run.runId} is not paused`);
        }

        interrupted = false;
        stream.reopen();
        const initialHandoff = await this.prepareInitialHandoff(input, run.runDir);
        await this.appendEvent(store, run.runId, { type: "run_started", workflow_id: workflowId, input }, (event) => stream.push(event));
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

  private async continueFrom(options: ContinueOptions): Promise<WorkflowState> {


    const tools = createLocalToolRegistry();


    const basePermissions = options.workflow.workflow_permissions ?? permissionSetSchema.parse(undefined);


    const attempts = [...options.attempts];


    let currentId: string | undefined = options.startNodeId;


    let handoff: unknown = options.initialHandoff;





    while (currentId) {


      if (options.isInterrupted?.()) {


        const state: WorkflowState = { status: "interrupted", workflow_id: options.workflowId, current_node_id: currentId, attempts, handoff };


        options.onState?.(state);


        await options.store.saveState(options.runId, state);


        return state;


      }





      const node = options.workflow.nodes.find((item) => item.id === currentId);


      if (!node) throw new Error(`Unknown node ${currentId}`);


      const role = options.config.roles[node.role];


      const providerConfig = options.config.providers[node.provider];


      this.assertCapabilities(node, role.requires, providerConfig.capabilities, handoff);





      const attempt = attempts.filter((item) => item.node_id === node.id).length + 1;


      attempts.push({ node_id: node.id, attempt, status: "running" });


      options.onState?.({ status: "running", workflow_id: options.workflowId, current_node_id: node.id, attempts, handoff });


      await this.appendEvent(options.store, options.runId, { type: "node_started", node_id: node.id, attempt }, options.eventSink);





      let result = await runNode({


        node,


        systemPrompt: role.system_prompt,


        model: node.model ?? role.default_model ?? providerConfig.default_model,


        provider: this.options.providerFactory(node.provider),


        tools,


        permissions: mergePermissions(basePermissions, node.permissions ?? permissionSetSchema.parse(undefined)),


        cwd: this.options.cwd,


        runId: options.runId,


        store: options.store,


        handoff,


        attempt,


        interaction: options.interaction,


        eventSink: options.eventSink


      });





      if (options.isInterrupted?.()) {


        const state: WorkflowState = { status: "interrupted", workflow_id: options.workflowId, current_node_id: node.id, attempts, handoff };


        options.onState?.(state);


        await options.store.saveState(options.runId, state);


        return state;


      }





      if (result.status === "needs_user_input") {


        attempts[attempts.length - 1] = { node_id: node.id, attempt, status: "waiting_user", result };


        await this.appendEvent(options.store, options.runId, { type: "node_waiting_user", node_id: node.id, questions: result.questions }, options.eventSink);


        const state: WorkflowState = { status: "waiting_user", workflow_id: options.workflowId, current_node_id: node.id, attempts, handoff };


        options.onState?.(state);


        await options.store.saveState(options.runId, state);


        return state;


      }





      if (node.mode === "complete" && result.status === "success") {


        const document = requireDocument(node, result);


        await this.appendEvent(options.store, options.runId, { type: "complete_summary_available", node_id: node.id, attempt, document }, options.eventSink);


      }





      if (node.mode === "plan" && result.status === "success") {


        const document = requireDocument(node, result);


        attempts[attempts.length - 1] = { node_id: node.id, attempt, status: "waiting_plan_review", result };


        await this.appendEvent(options.store, options.runId, { type: "plan_review_requested", node_id: node.id, attempt, document }, options.eventSink);


        const state: WorkflowState = {


          status: "waiting_plan_review",


          workflow_id: options.workflowId,


          current_node_id: node.id,


          attempts,


          handoff,


          pending_review: { type: "plan", node_id: node.id, attempt, document }


        };


        options.onState?.(state);


        await options.store.saveState(options.runId, state);


        return state;


      }





      const status = result.status === "success" ? "success" : "failure";


      attempts[attempts.length - 1] = { node_id: node.id, attempt, status, result };


      await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: node.id, status, result }, options.eventSink);





      const next = nextNodeId(options.workflow, node.id, status);


      if (!next) {


        const finalState: WorkflowState = { status: status === "success" ? "completed" : "failed", workflow_id: options.workflowId, attempts, handoff };


        options.onState?.(finalState);


        await options.store.saveState(options.runId, finalState);


        await this.appendEvent(


          options.store,


          options.runId,


          status === "success" ? { type: "run_completed", result: finalState } : { type: "run_failed", error: "Workflow ended with failure" },


          options.eventSink


        );


        return finalState;


      }





      await this.appendEvent(options.store, options.runId, { type: "transition", from: node.id, to: next, reason: status }, options.eventSink);


      handoff = buildHandoff(next, node.id, result, attempts.filter((item) => item.node_id === next).length + 1);


      currentId = next;


    }





    return { status: "completed", workflow_id: options.workflowId, attempts, handoff };


  }





  private async continuePlanReview(options: PlanReviewOptions): Promise<WorkflowState> {


    if (options.decision === "stay") {


      await this.appendEvent(options.store, options.runId, {


        type: "plan_review_resolved",


        node_id: options.state.current_node_id ?? "",


        attempt: options.state.pending_review?.attempt ?? 1,


        decision: "stay"


      }, options.eventSink);


      return options.state;


    }





    const nodeId = options.state.current_node_id;


    if (!nodeId) throw new Error(`Run ${options.runId} has no current node`);


    const node = options.workflow.nodes.find((item) => item.id === nodeId);


    if (!node) throw new Error(`Unknown node ${nodeId}`);


    const attempts = [...options.state.attempts];


    const attemptIndex = findWaitingPlanAttempt(attempts, nodeId);


    const attempt = attempts[attemptIndex];


    const result = attempt.result as NodeResult | undefined;


    if (!result) throw new Error(`Plan node ${nodeId} has no result to approve`);





    attempts[attemptIndex] = { ...attempt, status: "success" };


    await this.appendEvent(options.store, options.runId, { type: "plan_review_resolved", node_id: nodeId, attempt: attempt.attempt, decision: "continue" }, options.eventSink);


    await this.appendEvent(options.store, options.runId, { type: "node_completed", node_id: nodeId, status: "success", result }, options.eventSink);





    const next = nextNodeId(options.workflow, nodeId, "success");


    if (!next) {


      const finalState: WorkflowState = { status: "completed", workflow_id: options.workflowId, attempts, handoff: options.state.handoff };


      options.onState?.(finalState);


      await options.store.saveState(options.runId, finalState);


      await this.appendEvent(options.store, options.runId, { type: "run_completed", result: finalState }, options.eventSink);


      return finalState;


    }





    await this.appendEvent(options.store, options.runId, { type: "transition", from: nodeId, to: next, reason: "success" }, options.eventSink);


    const handoff = buildHandoff(next, nodeId, result, attempts.filter((item) => item.node_id === next).length + 1);


    return this.continueFrom({


      config: options.config,


      workflowId: options.workflowId,


      workflow: options.workflow,


      store: options.store,


      runId: options.runId,


      startNodeId: next,


      initialHandoff: handoff,


      attempts,


      eventSink: options.eventSink,


      interaction: options.interaction,


      isInterrupted: options.isInterrupted,


      onState: options.onState


    });


  }





  private async appendEvent(store: RunStore, runId: string, event: HarnessEvent, sink?: (event: StoredEvent) => void): Promise<StoredEvent> {


    const stored = await store.appendEvent(runId, event);


    sink?.(stored);


    return stored;


  }





  private async prepareInitialHandoff(input: unknown, runDir: string): Promise<unknown> {


    if (!input || typeof input !== "object") return input;


    const images = (input as { images?: unknown }).images;


    if (!Array.isArray(images) || !images.length) return input;





    const artifacts = new ArtifactStore(runDir);


    const refs = [];


    for (const image of images) {


      if (typeof image !== "string") continue;


      const ref = await artifacts.copyInputImage(image);


      refs.push({ artifact_id: ref.artifactId, path: ref.path, media_type: ref.mediaType });


    }


    return { ...input, images: refs };


  }





  private assertCapabilities(


    node: WorkflowNodeConfig,


    requires: { tool_calling?: boolean; vision?: boolean },


    capabilities: { tool_calling?: boolean; vision?: boolean },


    handoff: unknown


  ) {


    if (requires.tool_calling && !capabilities.tool_calling) throw new Error(`Node ${node.id} requires tool calling`);


    if ((requires.vision || handoffHasImages(handoff)) && !capabilities.vision) throw new Error(`Node ${node.id} requires vision`);


  }


}





function findWaitingPlanAttempt(attempts: WorkflowState["attempts"], nodeId: string): number {


  for (let index = attempts.length - 1; index >= 0; index -= 1) {


    const attempt = attempts[index];


    if (attempt.node_id === nodeId && attempt.status === "waiting_plan_review") return index;


  }


  throw new Error(`Plan node ${nodeId} is not waiting for review`);


}





function requireDocument(node: WorkflowNodeConfig, result: NodeResult): string {


  const document = result.document?.trim();


  if (!document) throw new Error(`${node.mode} node ${node.id} must return document`);


  return document;


}





function planReviewDecisionFromInput(input: unknown): PlanReviewDecision {


  const text = userMessageText(input).trim().toLowerCase();


  return ["yes", "y", "approve", "approved", "continue", "ok", "批准", "通过", "继续", "yes, continue execution by plan"].includes(text) ? "continue" : "stay";


}





function formatRunError(error: unknown): { message: string; detail?: string } {


  const message = error instanceof Error ? error.message : String(error);


  const detail = [explicitErrorDetail(error), causeErrorDetail(error)].filter(Boolean).join("\n");


  return { message, ...(detail ? { detail } : {}) };


}





function explicitErrorDetail(error: unknown): string | undefined {


  if (!error || typeof error !== "object") return undefined;


  const detail = (error as { detail?: unknown }).detail;


  return typeof detail === "string" && detail.trim() ? detail : undefined;


}





function causeErrorDetail(error: unknown): string | undefined {


  if (!(error instanceof Error) || !("cause" in error)) return undefined;


  const cause = (error as { cause?: unknown }).cause;


  if (!cause) return undefined;


  return errorDetailLines("cause", cause).join("\n");


}





function errorDetailLines(prefix: string, value: unknown): string[] {


  if (value instanceof Error) {


    const code = (value as Error & { code?: unknown }).code;


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





function userMessageText(input: unknown): string {


  if (typeof input === "string") return input;


  if (input && typeof input === "object") {


    const value = input as Record<string, unknown>;


    if (typeof value.answer === "string") return value.answer;


    if (typeof value.request === "string") return value.request;


  }


  return JSON.stringify(input);


}



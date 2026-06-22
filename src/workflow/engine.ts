import { AgentTeamConfig, permissionSetSchema, WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";
import { handoffHasImages } from "../harness/context.js";
import { HarnessEvent, StoredEvent } from "../harness/events.js";
import { EventStream } from "../harness/eventStream.js";
import { mergePermissions } from "../harness/permissions.js";
import { PermissionController } from "../harness/permissionController.js";
import { RuntimeInteraction, runNode } from "../harness/runtime.js";
import { ModelProvider } from "../providers/types.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { RunStore } from "../storage/runStore.js";
import { buildHandoff } from "../team/handoff.js";
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
};

export class WorkflowEngine {
  constructor(private readonly options: WorkflowEngineOptions) {}

  async run(config: AgentTeamConfig, workflowId: string, input: unknown): Promise<WorkflowState> {
    const workflow = config.workflows[workflowId];
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);

    const store = new RunStore(this.options.runRoot ?? ".runs");
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
    const store = new RunStore(this.options.runRoot ?? ".runs");
    const state = await store.loadState(runId);
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

  async startInteractive(config: AgentTeamConfig, workflowId: string, input: unknown): Promise<WorkflowSession> {
    const workflow = config.workflows[workflowId];
    if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);

    const store = new RunStore(this.options.runRoot ?? ".runs");
    const run = await store.createRun(workflowId, input);
    const initialHandoff = await this.prepareInitialHandoff(input, run.runDir);
    const stream = new EventStream<StoredEvent>();
    for (const event of await store.loadEvents(run.runId)) {
      stream.push(event);
    }

    const permissions = new PermissionController();
    const startNodeId = firstNodeId(workflow);
    let interrupted = false;
    let finished = false;
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
      if (finished) return;
      finished = true;
      latestState = state;
      resolveResult(state);
      stream.end();
    };

    const fail = async (error: unknown) => {
      if (finished) return;
      finished = true;
      const message = error instanceof Error ? error.message : String(error);
      await this.appendEvent(store, run.runId, { type: "run_failed", error: message }, (event) => stream.push(event));
      rejectResult(error);
      stream.end();
    };

    const runSegment = async (segment: { startNodeId: string; initialHandoff: unknown; attempts: WorkflowState["attempts"] }) => {
      if (finished) return latestState;
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
        latestState = state;
        if (state.status !== "waiting_user") finish(state);
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
        if (finished || interrupted) return;
        interrupted = true;
        let running: WorkflowState["attempts"][number] | undefined;
        for (let index = latestState.attempts.length - 1; index >= 0; index -= 1) {
          const attempt = latestState.attempts[index];
          if (attempt.status === "running") {
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
        latestState = state;
        if (!activeRun) finish(state);
      },
      resumeWithUserInput: async (input) => {
        if (finished) throw new Error(`Run ${run.runId} is already finished`);
        if (activeRun) await activeRun;
        if (latestState.status !== "waiting_user") throw new Error(`Run ${run.runId} is not waiting for user input`);
        if (!latestState.current_node_id) throw new Error(`Run ${run.runId} has no current node`);

        await runSegment({
          startNodeId: latestState.current_node_id,
          initialHandoff: { previous_handoff: latestState.handoff, user_input: input },
          attempts: latestState.attempts
        });
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

      const result = await runNode({
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
        interaction: options.interaction
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

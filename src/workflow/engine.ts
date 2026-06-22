import { AgentTeamConfig, permissionSetSchema, WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";
import { handoffHasImages } from "../harness/context.js";
import { mergePermissions } from "../harness/permissions.js";
import { runNode } from "../harness/runtime.js";
import { ModelProvider } from "../providers/types.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { RunStore } from "../storage/runStore.js";
import { buildHandoff } from "../team/handoff.js";
import { createLocalToolRegistry } from "../tools/registry.js";
import { WorkflowState } from "./state.js";
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

  private async continueFrom(options: ContinueOptions): Promise<WorkflowState> {
    const tools = createLocalToolRegistry();
    const basePermissions = options.workflow.workflow_permissions ?? permissionSetSchema.parse(undefined);
    const attempts = [...options.attempts];
    let currentId: string | undefined = options.startNodeId;
    let handoff: unknown = options.initialHandoff;

    while (currentId) {
      const node = options.workflow.nodes.find((item) => item.id === currentId);
      if (!node) throw new Error(`Unknown node ${currentId}`);
      const role = options.config.roles[node.role];
      const providerConfig = options.config.providers[node.provider];
      this.assertCapabilities(node, role.requires, providerConfig.capabilities, handoff);

      const attempt = attempts.filter((item) => item.node_id === node.id).length + 1;
      attempts.push({ node_id: node.id, attempt, status: "running" });
      await options.store.appendEvent(options.runId, { type: "node_started", node_id: node.id, attempt });

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
        handoff
      });

      if (result.status === "needs_user_input") {
        attempts[attempts.length - 1] = { node_id: node.id, attempt, status: "waiting_user", result };
        await options.store.appendEvent(options.runId, { type: "node_waiting_user", node_id: node.id, questions: result.questions });
        const state: WorkflowState = { status: "waiting_user", workflow_id: options.workflowId, current_node_id: node.id, attempts, handoff };
        await options.store.saveState(options.runId, state);
        return state;
      }

      const status = result.status === "success" ? "success" : "failure";
      attempts[attempts.length - 1] = { node_id: node.id, attempt, status, result };
      await options.store.appendEvent(options.runId, { type: "node_completed", node_id: node.id, status, result });

      const next = nextNodeId(options.workflow, node.id, status);
      if (!next) {
        const finalState: WorkflowState = { status: status === "success" ? "completed" : "failed", workflow_id: options.workflowId, attempts, handoff };
        await options.store.saveState(options.runId, finalState);
        return finalState;
      }

      await options.store.appendEvent(options.runId, { type: "transition", from: node.id, to: next, reason: status });
      handoff = buildHandoff(next, node.id, result, attempts.filter((item) => item.node_id === next).length + 1);
      currentId = next;
    }

    return { status: "completed", workflow_id: options.workflowId, attempts, handoff };
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

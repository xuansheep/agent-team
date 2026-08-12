import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import type { ModelMessage, ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { createKernelSession } from "../../src/kernel/session.js";
import { ExecutionCoordinator } from "../../src/runtime/executionCoordinator.js";
import { requestDispatchDirective } from "../../src/runtime/busDispatcher.js";
import { SessionExecutionBus } from "../../src/runtime/sessionExecutionBus.js";
import type { BusEvent, SessionBusCheckpoint } from "../../src/runtime/busTypes.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import type { WorkflowRunDossier } from "../../src/workflow/dossier.js";
import type { WorkflowSession } from "../../src/workflow/session.js";
import type { WorkflowState } from "../../src/workflow/state.js";
import { testDispatcher } from "../helpers/projectConfig.js";

const config: AgentTeamConfig = {
  providers: {
    default: {
      type: "openai-compatible",
      base_url: "https://api.example.test/v1",
      api_key: "test-key",
      default_model: "gpt-test",
      capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
    }
  },
  dispatcher: testDispatcher,
  roles: {
    product: { description: "Product planning", system_prompt: "product", requires: { tool_calling: false, vision: false } },
    dev: { description: "Implementation", system_prompt: "dev", requires: { tool_calling: false, vision: false } }
  },
  workflows: {
    delivery: {
      nodes: [
        { id: "product", role: "product", provider: "default", permission_mode: "default" },
        { id: "dev", role: "dev", provider: "default", permission_mode: "default" }
      ],
      edges: []
    }
  }
};

describe("SessionExecutionBus", () => {
  it("loads the optional bus role between global instructions and every phase routing protocol", async () => {
    const promptConfig: AgentTeamConfig = {
      ...config,
      global_prompt: "GLOBAL BUS TEST INSTRUCTIONS",
      roles: {
        ...config.roles,
        bus: {
          description: "Task orchestration",
          system_prompt: "BUS ROLE TEST STRATEGY",
          requires: { tool_calling: false, vision: false }
        }
      }
    };
    const provider = responseProvider(
      { type: "answer", confidence: 1, message: "Handled directly." },
      { type: "plan", confidence: 1, node_id: "product", reason: "Plan first." },
      {
        type: "finalize",
        confidence: 1,
        summary: {
          summary: "Complete.",
          outcomes: [],
          verification: [],
          residual_risks: [],
          artifacts: []
        }
      }
    );

    for (const phase of ["user", "plan", "lifecycle"] as const) {
      await requestDispatchDirective({
        config: promptConfig,
        workflowId: "delivery",
        sessionId: `session-${phase}`,
        phase,
        messages: [{ role: "user", content: "route this" }],
        providerFactory: provider.factory
      });
    }

    assert.equal(provider.requests.length, 3);
    for (const request of provider.requests) {
      const systemPrompt = String(request.messages.find((message) => message.role === "system")?.content ?? "");
      const globalIndex = systemPrompt.indexOf("GLOBAL BUS TEST INSTRUCTIONS");
      const roleIndex = systemPrompt.indexOf("BUS ROLE TEST STRATEGY");
      const protocolIndex = systemPrompt.indexOf("Never silently fall back to the first node");
      assert.ok(globalIndex >= 0);
      assert.ok(roleIndex > globalIndex);
      assert.ok(protocolIndex > roleIndex);
    }
  });

  it("keeps the built-in routing protocol when the bus role is absent", async () => {
    const provider = responseProvider({
      type: "answer",
      confidence: 1,
      message: "Handled directly."
    });
    const bus = createBus({ coordinator: fakeCoordinator(), providerFactory: provider.factory });

    await bus.handleUserMessage("answer this");

    const systemPrompt = String(provider.requests[0]?.messages.find((message) => message.role === "system")?.content ?? "");
    assert.match(systemPrompt, /You are the session execution bus/);
    assert.match(systemPrompt, /Never silently fall back to the first node/);
  });

  it("starts a workflow from the node selected by the bus", async () => {
    const workflow = createWorkflow({ currentNodeId: "dev" });
    const starts: Array<{ input: unknown; options: unknown }> = [];
    const coordinator = fakeCoordinator({
      startInteractive: async (_config, _workflowId, input, options) => {
        starts.push({ input, options });
        return workflow.session;
      }
    });
    const provider = responseProvider({
      type: "dispatch",
      confidence: 1,
      node_id: "dev",
      instruction: "Implement the requested change.",
      reason: "Implementation work"
    });
    const events: BusEvent[] = [];
    const bus = createBus({ coordinator, providerFactory: provider.factory, events });

    const turn = await bus.handleUserMessage({ request: "build it" });

    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]?.options, { permissionMode: undefined, sessionId: "session-bus", startNodeId: "dev" });
    assert.deepEqual(starts[0]?.input, {
      request: "Implement the requested change.",
      user_input: { request: "build it" }
    });
    assert.equal(turn.workflow, workflow.session);
    assert.equal(turn.state.current_node_id, "dev");
    assert.equal(turn.state.selected_node_id, "dev");
    assert.equal(events.some((event) => event.type === "bus_workflow_started" && event.node_id === "dev"), true);
  });

  it("routes team members through the bus with explicit team execution context", async () => {
    const teamConfig: AgentTeamConfig = {
      ...config,
      teams: { delivery: config.workflows.delivery }
    };
    const workflow = createWorkflow({ currentNodeId: "dev" });
    const starts: Array<{ options: { executionKind?: string; startNodeId?: string } }> = [];
    const coordinator = fakeCoordinator({
      startInteractive: async (_config, _workflowId, _input, options) => {
        assert.ok(options);
        starts.push({ options });
        return workflow.session;
      }
    });
    const provider = responseProvider({
      type: "dispatch",
      confidence: 1,
      node_id: "dev",
      instruction: "Implement the requested change.",
      reason: "Team member selected"
    });
    const bus = createBus({
      config: teamConfig,
      executionKind: "team",
      coordinator,
      providerFactory: provider.factory
    });

    await bus.handleUserMessage({ request: "build it" });

    assert.equal(bus.state.execution_kind, "team");
    assert.equal(starts[0]?.options.executionKind, "team");
    assert.equal(starts[0]?.options.startNodeId, "dev");
    const systemPrompt = provider.requests[0]?.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n") ?? "";
    assert.match(systemPrompt, /Members are unordered/);
    assert.match(systemPrompt, /Execution target: team delivery/);
  });

    it("exposes only phase-appropriate routing tools", async () => {
    const requests: ModelRequest[] = [];
    const workflow = createWorkflow({ currentNodeId: "dev" });
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            tool_calls: [{
              id: "dispatch-1",
              name: "DispatchWorkflowNode",
              input: {
                node_id: "dev",
                instruction: "Implement the change.",
                reason: "Implementation work",
                confidence: 1
              }
            }]
          };
        }
        return {
          tool_calls: [{
            id: "select-1",
            name: "SelectWorkflowNode",
            input: {
              node_id: "product",
              reason: "Plan requirements first",
              confidence: 1
            }
          }]
        };
      }
    };
    const toolCallingConfig: AgentTeamConfig = {
      ...config,
      providers: {
        default: {
          ...config.providers.default,
          capabilities: {
            ...config.providers.default.capabilities,
            tool_calling: true,
            json_schema_output: false
          }
        }
      }
    };
    const bus = createBus({
      config: toolCallingConfig,
      coordinator: fakeCoordinator({ startInteractive: async () => workflow.session }),
      providerFactory: () => provider
    });

    await bus.handleUserMessage("implement it");
    await bus.handleUserMessage("plan the follow-up", { planMode: true });

    assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["DispatchWorkflowNode"]);
    assert.deepEqual(requests[1]?.tools.map((tool) => tool.name), ["SelectWorkflowNode"]);
  });

  it("includes restored conversation and workflow state in dispatcher context", async () => {
    const historicalMessages: ModelMessage[] = [
      { role: "user", content: "initial request" },
      { role: "assistant", content: "Need implementation." }
    ];
    const workflow = createWorkflow({ currentNodeId: "dev", sessionId: "session-context" });
    workflow.setState({ status: "paused" });
    const provider = responseProvider({
      type: "answer",
      confidence: 1,
      message: "Context restored."
    });
    const checkpoint: SessionBusCheckpoint = {
      session_id: "session-context",
      workflow_id: "delivery",
      status: "waiting_user",
      revision: 4,
      active_run_id: workflow.session.runId,
      current_node_id: "dev",
      selected_node_id: "dev",
      rework_cycles: 1,
      last_directive: {
        type: "dispatch",
        confidence: 1,
        node_id: "dev",
        instruction: "Implement",
        reason: "Previous routing"
      }
    };
    const bus = createBus({
      coordinator: fakeCoordinator(),
      providerFactory: provider.factory,
      sessionId: "session-context",
      checkpoint,
      messages: historicalMessages
    });
    bus.adoptWorkflow(workflow.session, "dev");

    await bus.handleUserMessage("continue with the same task");

    const requestText = JSON.stringify(provider.requests[0]?.messages);
    assert.match(requestText, /initial request/);
    assert.match(requestText, /continue with the same task/);
    assert.match(requestText, /session_execution_context/);
    assert.match(requestText, /session-context/);
    assert.match(requestText, /paused/);
    assert.match(requestText, /Previous routing/);
  });

  it("continues a completed workflow in the existing run", async () => {
    const workflow = createWorkflow({ currentNodeId: "dev", sessionId: "session-continuation" });
    workflow.setState({ status: "completed", final_summary: "first cycle" });
    let starts = 0;
    const provider = responseProvider({
      type: "dispatch",
      confidence: 1,
      node_id: "dev",
      instruction: "Apply the follow-up.",
      reason: "Follow-up implementation"
    });
    const bus = createBus({
      coordinator: fakeCoordinator({
        startInteractive: async () => {
          starts += 1;
          return workflow.session;
        }
      }),
      providerFactory: provider.factory,
      sessionId: "session-continuation"
    });
    bus.adoptWorkflow(workflow.session, "dev");

    const turn = await bus.handleUserMessage("add the follow-up");

    assert.equal(starts, 0);
    assert.equal(turn.workflow?.runId, workflow.session.runId);
    assert.equal(workflow.dispatches.length, 1);
    assert.equal(workflow.dispatches[0]?.nodeId, "dev");
  });

  it("emits and persists bus thinking with the selected directive", async () => {
    const root = join(process.cwd(), ".tmp", "session-execution-bus-thinking", randomUUID());
    const store = new SessionStore(root);
    const workflow = createWorkflow({ currentNodeId: "dev", sessionId: "session-thinking" });
    const coordinator = fakeCoordinator({
      startInteractive: async () => workflow.session
    });
    const provider: ModelProvider = {
      async generate() {
        return {
          thinking: "Checked node responsibilities.",
          content: JSON.stringify({
            type: "dispatch",
            confidence: 0.96,
            node_id: "dev",
            instruction: "Implement the change.",
            reason: "The request is implementation work"
          })
        };
      }
    };
    const events: BusEvent[] = [];
    const bus = createBus({
      coordinator,
      providerFactory: () => provider,
      events,
      sessionStore: store,
      sessionId: "session-thinking"
    });

    await bus.handleUserMessage("implement it");

    const started = events.find((event) => event.type === "bus_routing_started");
    const thinking = events.find((event) => event.type === "bus_model_thinking_delta");
    const selected = events.find((event) => event.type === "bus_directive_selected");
    assert.ok(started && thinking && selected);
    assert.equal(thinking.routing_id, started.routing_id);
    assert.equal(selected.routing_id, started.routing_id);
    assert.equal(thinking.text, "Checked node responsibilities.");
    assert.equal(selected.thinking, "Checked node responsibilities.");
    assert.equal(selected.directive.type, "dispatch");

    const persisted = await store.loadBusRoutingEvents("session-thinking");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.event.routing_id, started.routing_id);
    assert.equal(persisted[0]?.event.thinking, "Checked node responsibilities.");
  });

  it("correlates streamed bus thinking and retry rollback with one routing turn", async () => {
    const provider: ModelProvider = {
      async generate() {
        throw new Error("stream should be used");
      },
      async stream(request, onEvent) {
        onEvent({ type: "thinking_delta", text: "discarded" });
        await request.onRetry?.({
          phase: "stream",
          retryAttempt: 1,
          maxRetries: 2,
          retryInMs: 0,
          scheduledAt: "2026-08-10T00:00:00.000Z",
          retryAt: "2026-08-10T00:00:00.000Z",
          errorKind: "network",
          message: "stream interrupted",
          discardedContentChars: 0,
          discardedThinkingChars: 9
        });
        onEvent({ type: "thinking_delta", text: "kept" });
        return {
          thinking: "kept",
          content: JSON.stringify({
            type: "plan",
            confidence: 1,
            node_id: "dev",
            reason: "Implementation planning"
          })
        };
      }
    };
    const events: BusEvent[] = [];
    const bus = createBus({
      coordinator: fakeCoordinator(),
      providerFactory: () => provider,
      events
    });

    await bus.handleUserMessage("plan it", { planMode: true });

    const started = events.find((event) => event.type === "bus_routing_started");
    const retry = events.find((event) => event.type === "bus_dispatcher_retry_scheduled");
    const selected = events.find((event) => event.type === "bus_directive_selected");
    const deltas = events.filter((event) => event.type === "bus_model_thinking_delta");
    assert.ok(started && retry && selected);
    assert.deepEqual(deltas.map((event) => event.text), ["discarded", "kept"]);
    assert.equal(retry.routing_id, started.routing_id);
    assert.equal(retry.discarded_thinking_chars, 9);
    assert.equal(selected.routing_id, started.routing_id);
    assert.equal(selected.thinking, "kept");
  });

  it("restores the latest Plan node selection and uses it after approval", async () => {
    const root = join(process.cwd(), ".tmp", "session-execution-bus", randomUUID());
    const store = new SessionStore(root);
    const provider = responseProvider(
      { type: "plan", confidence: 1, node_id: "product", reason: "Start with requirements" },
      { type: "plan", confidence: 1, node_id: "dev", reason: "Latest plan targets implementation" }
    );
    const firstBus = createBus({
      coordinator: fakeCoordinator(),
      providerFactory: provider.factory,
      sessionStore: store,
      sessionId: "session-plan"
    });

    await firstBus.handleUserMessage({ request: "plan this" }, { planMode: true });
    await firstBus.handleUserMessage({ request: "implement directly after planning" }, { planMode: true });

    const checkpoint = await store.loadBusState("session-plan");
    const transcript = await store.loadBusTranscript("session-plan");
    assert.equal(checkpoint?.selected_node_id, "dev");
    assert.equal(checkpoint?.status, "planning");
    assert.deepEqual(transcript.map((entry) => entry.phase), ["bus", "bus"]);
    assert.deepEqual(transcript.map((entry) => entry.message.content), ["plan this", "implement directly after planning"]);
    firstBus.dispose();

    const workflow = createWorkflow({ currentNodeId: "dev", sessionId: "session-plan" });
    const approvedSession = {
      ...createKernelSession({
        id: "session-plan",
        cwd: process.cwd(),
        permissions: { mode: "default", allow: [], ask: [], deny: [] }
      }),
      status: "running_workflow" as const,
      workflowBinding: { runId: workflow.session.runId, status: "running" as const }
    };
    let approvedStartNode: string | undefined;
    const restoredCoordinator = fakeCoordinator({
      resolvePlanApprovalAndStart: async (input) => {
        approvedStartNode = input.startNodeId;
        return { resolution: { session: approvedSession } as never, workflow: workflow.session };
      }
    });
    const restored = createBus({
      coordinator: restoredCoordinator,
      providerFactory: responseProvider().factory,
      sessionStore: store,
      sessionId: "session-plan",
      checkpoint: checkpoint as SessionBusCheckpoint,
      messages: transcript.map((entry) => entry.message)
    });

    await restored.approvePlan({ session: {} as never });

    assert.equal(approvedStartNode, "dev");
    assert.equal(restored.state.selected_node_id, "dev");
    assert.equal(restored.state.status, "running_workflow");
    assert.equal(restored.state.messages.length, 2);
  });

  it("approves Plan Mode by reusing the active workflow and persists the binding", async () => {
    const root = join(process.cwd(), ".tmp", "session-execution-bus", randomUUID());
    const store = new SessionStore(root);
    const workflow = createWorkflow({ currentNodeId: "product", sessionId: "session-existing-plan" });
    const approvedSession = {
      ...createKernelSession({
        id: "session-existing-plan",
        cwd: process.cwd(),
        permissions: { mode: "default", allow: [], ask: [], deny: [] }
      }),
      status: "running_workflow" as const,
      workflowBinding: { runId: workflow.session.runId, status: "running" as const }
    };
    let approvedNodeId: string | undefined;
    const coordinator = fakeCoordinator({
      resolvePlanApprovalAndDispatch: async (input) => {
        approvedNodeId = input.startNodeId;
        await input.workflow.dispatchToNode(input.startNodeId, { approved_plan: "Implement safely." }, {
          reason: input.reason,
          permissionMode: input.permissionMode
        });
        return { resolution: { session: approvedSession } as never, workflow: input.workflow };
      }
    });
    const events: BusEvent[] = [];
    const bus = createBus({
      coordinator,
      providerFactory: responseProvider({
        type: "plan",
        confidence: 1,
        node_id: "dev",
        reason: "The approved plan starts with implementation"
      }).factory,
      events,
      sessionStore: store,
      sessionId: "session-existing-plan"
    });
    bus.adoptWorkflow(workflow.session, "product");

    await bus.handleUserMessage({ request: "plan the implementation" }, { planMode: true });
    const approval = await bus.approvePlan({
      session: createKernelSession({
        id: "session-existing-plan",
        cwd: process.cwd(),
        permissions: { mode: "plan", allow: [], ask: [], deny: [] }
      }),
      permissionMode: "fullAccess"
    });

    assert.equal(approval.transition?.workflow, workflow.session);
    assert.equal(approvedNodeId, "dev");
    assert.equal(workflow.dispatches.length, 1);
    assert.deepEqual(workflow.dispatches[0]?.options, {
      reason: "Approved Plan Mode handoff",
      permissionMode: "fullAccess"
    });
    assert.equal(bus.state.status, "running_workflow");
    assert.equal(bus.state.current_node_id, "dev");
    assert.equal(events.some((event) => event.type === "bus_workflow_reassigned" && event.to_node_id === "dev"), true);
    const metadata = await store.loadMetadata("session-existing-plan");
    assert.equal(metadata?.execution?.workflowBinding?.runId, workflow.session.runId);
  });

  it("asks for clarification when dispatcher confidence is below threshold", async () => {
    let starts = 0;
    const coordinator = fakeCoordinator({
      startInteractive: async () => {
        starts += 1;
        return createWorkflow().session;
      }
    });
    const provider = responseProvider({
      type: "dispatch",
      confidence: 0.4,
      node_id: "product",
      instruction: "Start",
      reason: "Unsure"
    });
    const events: BusEvent[] = [];
    const bus = createBus({ coordinator, providerFactory: provider.factory, events });

    const turn = await bus.handleUserMessage("ambiguous request");

    assert.equal(turn.directive.type, "clarify");
    assert.equal(turn.state.status, "waiting_user");
    assert.equal(starts, 0);
    const clarification = events.find((event) => event.type === "bus_clarification_requested") as Extract<BusEvent, { type: "bus_clarification_requested" }> | undefined;
    assert.equal(clarification?.reason, "low_confidence");
  });

  it("asks for clarification when dispatcher output is invalid", async () => {
    const events: BusEvent[] = [];
    const bus = createBus({
      coordinator: fakeCoordinator(),
      providerFactory: responseProvider("not-json").factory,
      events
    });

    const turn = await bus.handleUserMessage("route this");

    assert.equal(turn.directive.type, "clarify");
    assert.match(turn.directive.type === "clarify" ? turn.directive.message : "", /没有返回可验证的路由决策/);
    const clarification = events.find((event) => event.type === "bus_clarification_requested") as Extract<BusEvent, { type: "bus_clarification_requested" }> | undefined;
    assert.equal(clarification?.reason, "invalid_directive");
  });

  it("asks for clarification when the dispatcher provider fails", async () => {
    const events: BusEvent[] = [];
    const bus = createBus({
      coordinator: fakeCoordinator(),
      providerFactory: responseProvider().factory,
      turnEngine: {
        async requestModel() {
          throw new Error("provider unavailable");
        }
      } as never,
      events
    });

    const turn = await bus.handleUserMessage("route this");

    assert.equal(turn.directive.type, "clarify");
    assert.match(turn.directive.type === "clarify" ? turn.directive.message : "", /暂时无法可靠处理/);
    const clarification = events.find((event) => event.type === "bus_clarification_requested") as Extract<BusEvent, { type: "bus_clarification_requested" }> | undefined;
    assert.equal(clarification?.reason, "dispatcher_failure");
  });

  it("aborts an active dispatcher request before interrupting the workflow", async () => {
    let request: ModelRequest | undefined;
    let workflowStarts = 0;
    const provider: ModelProvider = {
      generate: (nextRequest) => new Promise((_resolve, reject) => {
        request = nextRequest;
        const abort = () => reject(nextRequest.signal?.reason ?? new Error("dispatcher request aborted"));
        if (nextRequest.signal?.aborted) abort();
        else nextRequest.signal?.addEventListener("abort", abort, { once: true });
      })
    };
    const events: BusEvent[] = [];
    const bus = createBus({
      coordinator: fakeCoordinator({
        startInteractive: async () => {
          workflowStarts += 1;
          return createWorkflow().session;
        }
      }),
      providerFactory: () => provider,
      events
    });

    const turn = bus.handleUserMessage("route this request");
    await waitFor(() => Boolean(request));
    const rejectedTurn = assert.rejects(turn, /Session execution bus interrupted/);

    await bus.interrupt();
    await rejectedTurn;

    assert.equal(request?.signal?.aborted, true);
    assert.equal(workflowStarts, 0);
    assert.equal(bus.state.status, "waiting_user");
    assert.equal(events.some((event) => event.type === "bus_clarification_requested"), false);
  });

  it("reassigns safely, proxies permissions and interruption, and rejects a second active workflow", async () => {
    const workflow = createWorkflow({ currentNodeId: "product" });
    let starts = 0;
    const coordinator = fakeCoordinator({
      startInteractive: async () => {
        starts += 1;
        return workflow.session;
      }
    });
    const provider = responseProvider(
      { type: "dispatch", confidence: 1, node_id: "product", instruction: "Define requirements", reason: "Product first" },
      { type: "dispatch", confidence: 1, node_id: "dev", instruction: "Implement now", reason: "Requirements are ready" }
    );
    const events: BusEvent[] = [];
    const bus = createBus({ coordinator, providerFactory: provider.factory, events });

    await bus.handleUserMessage({ request: "start" });
    await bus.handleUserMessage({ request: "move to implementation" });
    bus.resolvePermission("permission-1", "allow_once");

    assert.equal(starts, 1);
    assert.equal(workflow.dispatches.length, 1);
    assert.equal(workflow.dispatches[0]?.nodeId, "dev");
    assert.deepEqual(workflow.dispatches[0]?.input, {
      request: "Implement now",
      user_input: { request: "move to implementation" }
    });
    assert.deepEqual(workflow.dispatches[0]?.options, { reason: "Requirements are ready", countsAsRework: false });
    assert.deepEqual(workflow.permissionDecisions, [["permission-1", "allow_once"]]);
    assert.equal(events.some((event) => event.type === "bus_workflow_reassigned" && event.to_node_id === "dev"), true);

    const secondWorkflow = createWorkflow({ runId: "run-second", currentNodeId: "product" });
    assert.throws(() => bus.adoptWorkflow(secondWorkflow.session), /already has active workflow/);

    await bus.interrupt();
    assert.equal(workflow.interrupts, 1);
    assert.equal(bus.state.status, "waiting_user");
  });

  it("keeps the full dossier for routing but passes bounded context to the node", async () => {
    const workflow = createWorkflow({
      currentNodeId: "product",
      attempts: [{ node_id: "dev", attempt: 1, activation: 1, status: "completed" }]
    });
    const runDossier = dossier(workflow.session.runId, "product", workflow.state.attempts);
    runDossier.node_results.push({
      seq: 7,
      ts: "2026-08-10T00:00:00.000Z",
      node_id: "product",
      attempt: 1,
      activation: 1,
      status: "completed",
      result: {
        direction: "forward",
        summary: "Inspection complete",
        document: "Full inspection document retained for bus routing only.",
        deliverables: [{ artifact_id: "artifact-inspection", description: "Inspection evidence" }],
        feedback: { defects: ["defect-1"], change_requests: [] },
        questions: [],
        handoff: {
          instruction: "Repair the inspection findings",
          must_follow: ["Preserve compatibility"],
          known_risks: ["Regression risk"],
          open_questions: []
        }
      }
    });
    const coordinator = fakeCoordinator({
      startInteractive: async () => workflow.session,
      dossier: async () => runDossier
    });
    const provider = responseProvider(
      { type: "dispatch", confidence: 1, node_id: "product", instruction: "Inspect", reason: "Start inspection" },
      { type: "dispatch", confidence: 1, node_id: "dev", instruction: "Repair findings", reason: "Dossier shows rework" }
    );
    const bus = createBus({ coordinator, providerFactory: provider.factory });

    await bus.handleUserMessage({ request: "inspect and repair" });
    workflow.setState({ status: "awaiting_bus" });
    await waitFor(() => workflow.dispatches.length === 1);

    assert.equal(workflow.dispatches[0]?.nodeId, "dev");
    assert.deepEqual(workflow.dispatches[0]?.options, { reason: "Dossier shows rework", countsAsRework: true });
    const nodeInput = workflow.dispatches[0]?.input as {
      prior_dossier?: unknown;
      prior_results?: unknown[];
      references?: unknown[];
    };
    assert.equal("prior_dossier" in nodeInput, false);
    assert.deepEqual(nodeInput.prior_results, [{
      node_id: "product",
      attempt: 1,
      activation: 1,
      status: "completed",
      summary: "Inspection complete",
      deliverables: [{ artifact_id: "artifact-inspection", description: "Inspection evidence" }],
      feedback: { defects: ["defect-1"], change_requests: [] },
      handoff: {
        instruction: "Repair the inspection findings",
        must_follow: ["Preserve compatibility"],
        known_risks: ["Regression risk"],
        open_questions: []
      }
    }]);
    assert.deepEqual(nodeInput.references, [{
      node_id: "product",
      summary: "Inspection complete",
      artifact_ids: ["artifact-inspection"]
    }]);
    assert.equal(bus.state.current_node_id, "dev");
    assert.equal(bus.state.status, "running_workflow");
    const dispatcherContext = JSON.stringify(provider.requests[1]?.messages);
    assert.match(dispatcherContext, /workflow_run_dossier/);
    assert.match(dispatcherContext, /Full inspection document retained for bus routing only/);
  });

  it("keeps repeated lifecycle dispatch payloads flat and stable", async () => {
    const workflow = createWorkflow({ currentNodeId: "product" });
    const runDossier = dossier(workflow.session.runId, "product");
    const directive = {
      type: "dispatch" as const,
      confidence: 1,
      node_id: "dev",
      instruction: "Continue implementation",
      reason: "Lifecycle continuation"
    };
    const provider = responseProvider(directive, directive, directive, directive, directive);
    const bus = createBus({
      coordinator: fakeCoordinator({
        startInteractive: async () => workflow.session,
        dossier: async () => runDossier
      }),
      providerFactory: provider.factory
    });

    await bus.handleUserMessage("start");
    for (let activation = 1; activation <= 4; activation += 1) {
      workflow.setState({
        status: "awaiting_bus",
        current_node_id: "product",
        attempts: [{ node_id: "product", attempt: 1, activation, status: "completed" }]
      });
      await waitFor(() => workflow.dispatches.length === activation);
    }

    const serialized = workflow.dispatches.map((dispatch) => JSON.stringify(dispatch.input));
    assert.equal(serialized.every((input) => !input.includes("prior_dossier")), true);
    assert.equal(new Set(serialized.map((input) => input.length)).size, 1);
  });

  it("does not count the first lifecycle entry into an unvisited node as rework", async () => {
    const workflow = createWorkflow({ currentNodeId: "product" });
    const runDossier = dossier(workflow.session.runId, "product", workflow.state.attempts);
    const coordinator = fakeCoordinator({
      startInteractive: async () => workflow.session,
      dossier: async () => runDossier
    });
    const provider = responseProvider(
      { type: "dispatch", confidence: 1, node_id: "product", instruction: "Inspect", reason: "Start inspection" },
      { type: "dispatch", confidence: 1, node_id: "dev", instruction: "Implement findings", reason: "First implementation pass" }
    );
    const bus = createBus({ coordinator, providerFactory: provider.factory });

    await bus.handleUserMessage({ request: "inspect then implement" });
    workflow.setState({ status: "awaiting_bus" });
    await waitFor(() => workflow.dispatches.length === 1);

    assert.equal(workflow.dispatches[0]?.nodeId, "dev");
    assert.deepEqual(workflow.dispatches[0]?.options, {
      reason: "First implementation pass",
      countsAsRework: false
    });
  });

  it("routes a user reply at awaiting_bus through lifecycle management", async () => {
    const workflow = createWorkflow({ currentNodeId: "product" });
    const runDossier = dossier(workflow.session.runId, "product", workflow.state.attempts);
    let dossierReads = 0;
    const coordinator = fakeCoordinator({
      startInteractive: async () => workflow.session,
      dossier: async () => {
        dossierReads += 1;
        return runDossier;
      }
    });
    const provider = responseProvider(
      { type: "dispatch", confidence: 1, node_id: "product", instruction: "Inspect", reason: "Start inspection" },
      { type: "clarify", confidence: 1, message: "Which node should handle the follow-up?" },
      { type: "dispatch", confidence: 1, node_id: "dev", instruction: "Apply the requested follow-up", reason: "User selected implementation" }
    );
    const bus = createBus({ coordinator, providerFactory: provider.factory });

    await bus.handleUserMessage({ request: "inspect" });
    workflow.setState({ status: "awaiting_bus" });
    await waitFor(() => bus.state.status === "waiting_user" && provider.requests.length === 2);

    const turn = await bus.handleUserMessage({ request: "send the follow-up to implementation" });

    assert.equal(turn.directive.type, "dispatch");
    assert.equal(dossierReads, 2);
    assert.equal(workflow.dispatches[0]?.nodeId, "dev");
    assert.deepEqual(workflow.dispatches[0]?.options, {
      reason: "User selected implementation",
      countsAsRework: false
    });
    assert.equal(provider.requests[2]?.messages.some((message) => typeof message.content === "string" && message.content.includes("workflow_run_dossier")), true);
  });

  it("finalizes the workflow from its dossier and emits the task summary", async () => {
    const workflow = createWorkflow({ currentNodeId: "dev" });
    const runDossier = dossier(workflow.session.runId, "dev");
    const coordinator = fakeCoordinator({
      startInteractive: async () => workflow.session,
      dossier: async () => runDossier
    });
    const provider = responseProvider(
      { type: "dispatch", confidence: 1, node_id: "dev", instruction: "Implement", reason: "Ready" },
      {
        type: "finalize",
        confidence: 1,
        summary: {
          summary: "Delivery completed safely.",
          outcomes: ["Feature implemented"],
          verification: ["Targeted tests passed"],
          residual_risks: ["Full component suite was skipped"],
          artifacts: ["artifact://delivery"]
        }
      }
    );
    const events: BusEvent[] = [];
    const bus = createBus({ coordinator, providerFactory: provider.factory, events });

    await bus.handleUserMessage({ request: "deliver" });
    workflow.setState({ status: "awaiting_bus" });
    await waitFor(() => workflow.finalizedDocuments.length === 1);

    const document = workflow.finalizedDocuments[0] ?? "";
    assert.match(document, /Delivery completed safely/);
    assert.match(document, /## Outcomes/);
    assert.match(document, /## Verification/);
    assert.match(document, /## Residual risks/);
    assert.match(document, /## Artifacts/);
    assert.equal(bus.state.status, "finalized");
    assert.equal(bus.state.summary?.summary, "Delivery completed safely.");
    assert.equal(events.some((event) => event.type === "bus_task_finalized"), true);
    assert.equal(provider.requests[1]?.messages.some((message) => typeof message.content === "string" && message.content.includes("workflow_run_dossier")), true);
  });
});

type CoordinatorHooks = {
  startInteractive?: ExecutionCoordinator["startInteractive"];
  dossier?: ExecutionCoordinator["dossier"];
  resolvePlanApprovalAndStart?: ExecutionCoordinator["resolvePlanApprovalAndStart"];
  resolvePlanApprovalAndDispatch?: ExecutionCoordinator["resolvePlanApprovalAndDispatch"];
};

function fakeCoordinator(hooks: CoordinatorHooks = {}): ExecutionCoordinator {
  return {
    startInteractive: hooks.startInteractive ?? (async () => {
      throw new Error("Unexpected workflow start");
    }),
    dossier: hooks.dossier ?? (async (runId: string) => dossier(runId, "product")),
    resolvePlanApprovalAndStart: hooks.resolvePlanApprovalAndStart ?? (async () => {
      throw new Error("Unexpected Plan approval");
    }),
    resolvePlanApprovalAndDispatch: hooks.resolvePlanApprovalAndDispatch ?? (async () => {
      throw new Error("Unexpected existing workflow Plan approval");
    })
  } as unknown as ExecutionCoordinator;
}

type CreateBusOptions = {
  config?: AgentTeamConfig;
  executionKind?: "workflow" | "team";
  coordinator: ExecutionCoordinator;
  providerFactory: (providerId: string) => ModelProvider;
  events?: BusEvent[];
  sessionStore?: SessionStore;
  sessionId?: string;
  checkpoint?: SessionBusCheckpoint;
  messages?: ModelMessage[];
  turnEngine?: ConstructorParameters<typeof SessionExecutionBus>[0]["turnEngine"];
};

function createBus(options: CreateBusOptions): SessionExecutionBus {
  const bus = new SessionExecutionBus({
    config: options.config ?? config,
    workflowId: "delivery",
    executionKind: options.executionKind,
    coordinator: options.coordinator,
    providerFactory: options.providerFactory,
    cwd: process.cwd(),
    sessionId: options.sessionId ?? "session-bus",
    sessionStore: options.sessionStore,
    checkpoint: options.checkpoint,
    messages: options.messages,
    turnEngine: options.turnEngine
  });
  if (options.events) bus.subscribe((event) => { options.events!.push(event); });
  return bus;
}

function responseProvider(...responses: Array<Record<string, unknown> | string>) {
  const pending = [...responses];
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    async generate(request) {
      requests.push(request);
      const response = pending.shift();
      if (response === undefined) throw new Error("No dispatcher response was queued");
      return { content: typeof response === "string" ? response : JSON.stringify(response) };
    }
  };
  return { factory: () => provider, requests };
}

type WorkflowOptions = {
  runId?: string;
  sessionId?: string;
  currentNodeId?: string;
  attempts?: WorkflowState["attempts"];
};

function createWorkflow(options: WorkflowOptions = {}) {
  const listeners = new Set<(state: WorkflowState) => void>();
  const state: WorkflowState = {
    status: "running",
    workflow_id: "delivery",
    current_node_id: options.currentNodeId ?? "product",
    attempts: options.attempts?.map((attempt) => ({ ...attempt })) ?? [],
    rework_count: 0,
    rework_limit: 3
  };
  const dispatches: Array<{ nodeId: string; input: unknown; options: unknown }> = [];
  const permissionDecisions: Array<[string, string]> = [];
  const finalizedDocuments: string[] = [];
  let interrupts = 0;
  let resolveResult!: (state: WorkflowState) => void;
  const result = new Promise<WorkflowState>((resolve) => {
    resolveResult = resolve;
  });
  const setState = (update: Partial<WorkflowState>) => {
    Object.assign(state, update);
    for (const listener of listeners) listener({ ...state });
  };
  const session = {
    sessionId: options.sessionId ?? "session-bus",
    runId: options.runId ?? `run-${randomUUID()}`,
    state,
    events: { async *[Symbol.asyncIterator]() {} },
    permissions: {
      resolve(requestId: string, decision: string) { permissionDecisions.push([requestId, decision]); },
      resolveAll() {},
      hasPending() { return false; }
    },
    async interrupt() {
      interrupts += 1;
    },
    async resumeWithUserInput(input: unknown) {
      dispatches.push({ nodeId: state.current_node_id ?? "", input, options: { resume: true } });
      setState({ status: "running" });
    },
    async continueWithInput() {},
    async dispatchToNode(nodeId: string, input: unknown, dispatchOptions?: unknown) {
      dispatches.push({ nodeId, input, options: dispatchOptions });
      setState({ status: "running", current_node_id: nodeId });
    },
    async finalize(summary: string) {
      finalizedDocuments.push(summary);
      setState({ status: "completed", final_summary: summary });
      resolveResult({ ...state });
    },
    subscribeState(listener: (next: WorkflowState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async waitForBoundary() {
      return { ...state };
    },
    result
  } as unknown as WorkflowSession;
  return {
    session,
    state,
    dispatches,
    permissionDecisions,
    finalizedDocuments,
    setState,
    get interrupts() { return interrupts; }
  };
}

function dossier(
  runId: string,
  currentNodeId: string,
  attempts: WorkflowState["attempts"] = []
): WorkflowRunDossier {
  return {
    run_id: runId,
    workflow_id: "delivery",
    status: "awaiting_bus",
    current_node_id: currentNodeId,
    rework_count: 0,
    rework_limit: 3,
    attempts: attempts.map((attempt) => ({
      node_id: attempt.node_id,
      attempt: attempt.attempt,
      activation: attempt.activation ?? 1,
      status: attempt.status
    })),
    node_results: [],
    artifacts: [],
    lifecycle: {
      tools: [],
      permissions: [],
      processes: [],
      failures: [],
      model_response_count: 1,
      user_interaction_count: 0
    },
    omitted_payloads: [
      "model_stream_delta",
      "model_thinking_delta",
      "raw_tool_input",
      "raw_tool_result",
      "workflow_dialogue"
    ]
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for SessionExecutionBus");
}

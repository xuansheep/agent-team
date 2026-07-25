import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import { createKernelSession } from "../../src/kernel/session.js";
import { PlanModeController } from "../../src/kernel/plan/planModeController.js";
import { ExecutionCoordinator } from "../../src/runtime/executionCoordinator.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { writePlan } from "../../src/plans/planFiles.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { createLocalToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import type { WorkflowEngine } from "../../src/workflow/engine.js";
import type { WorkflowSession } from "../../src/workflow/session.js";

async function workspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("ExecutionCoordinator", () => {
  it("projects AskUserQuestion into a durable kernel interaction", async () => {
    const cwd = await workspace("agent-team-coordinator-question-");
    const store = new SessionStore(join(cwd, ".session"));
    const base = createKernelSession({
      id: "session-question",
      cwd,
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      messages: [{ role: "user", content: "plan this" }]
    });
    const planning = new PlanModeController().enterPlanMode(base, { request: "plan this" });
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Need clarification.",
          tool_calls: [{
            id: "ask-1",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Which region?", header: "Region", options: [{ label: "A", description: "Use A" }, { label: "B", description: "Use B" }], multiSelect: false }] }
          }]
        };
      }
    };
    const coordinator = new ExecutionCoordinator(undefined, { sessionStore: store });

    const result = await coordinator.executeSession({
      session: planning,
      provider,
      model: "test-model",
      tools: createLocalToolRegistry(),
      globalPrompt: "sensitive-global-prompt-must-not-be-persisted"
    });

    assert.equal(result.outcome.status, "waiting_user_input");
    assert.equal(result.session.status, "waiting_user_input");
    assert.equal(result.session.pendingInteraction?.type, "ask_user_question");
    assert.equal(result.session.pendingInteraction?.id, "ask-1");
    const metadata = await store.loadMetadata(planning.id);
    assert.doesNotMatch(JSON.stringify(metadata?.execution?.messages), /sensitive-global-prompt-must-not-be-persisted/);
    const restored = await store.restoreKernelSession(planning.id, cwd);
    assert.equal(restored?.pendingInteraction?.type, "ask_user_question");
    assert.equal(restored?.messages.at(-1)?.role, "assistant");
    assert.equal(restored?.messages.at(-1)?.tool_calls?.[0]?.id, "ask-1");
  });

  it("adopts ExitPlanMode as a durable approval even when pre-plan mode is fullAccess", async () => {
    const cwd = await workspace("agent-team-coordinator-approval-");
    const store = new SessionStore(join(cwd, ".session"));
    const base = createKernelSession({
      id: "session-approval",
      cwd,
      permissions: { mode: "fullAccess", allow: [], ask: [], deny: [] },
      messages: [{ role: "user", content: "plan this" }]
    });
    const planning = new PlanModeController().enterPlanMode(base, { request: "plan this" });
    assert.ok(planning.planState);
    await writePlan(planning.planState.planFilePath, "# Plan\n\nApprove me.\n");
    const provider: ModelProvider = {
      async generate() {
        return { content: "Ready.", tool_calls: [{ id: "exit-1", name: "ExitPlanMode", input: {} }] };
      }
    };
    let capturedWorkflowInput: unknown;
    let capturedWorkflowOptions: unknown;
    const workflowSession = { sessionId: planning.id, runId: "run-approved" } as WorkflowSession;
    const workflowEngine = {
      async startInteractive(_config: AgentTeamConfig, _workflowId: string, input: unknown, options: unknown) {
        capturedWorkflowInput = input;
        capturedWorkflowOptions = options;
        return workflowSession;
      }
    } as unknown as WorkflowEngine;
    const coordinator = new ExecutionCoordinator(workflowEngine, { sessionStore: store });

    const result = await coordinator.executeSession({
      session: planning,
      provider,
      model: "test-model",
      tools: createLocalToolRegistry()
    });

    assert.equal(result.outcome.status, "waiting_plan_approval");
    assert.equal(result.session.status, "waiting_plan_approval");
    assert.equal(result.session.pendingInteraction?.type, "plan_approval");
    assert.equal(result.session.pendingInteraction?.toolCallId, "exit-1");
    assert.equal(result.session.planState?.mode, "waiting_approval");
    assert.equal(result.session.planState?.prePlanMode, "fullAccess");
    const metadata = await store.loadMetadata(planning.id);
    assert.equal(metadata?.execution?.pendingInteraction?.type, "plan_approval");
    assert.equal(metadata?.execution?.planState?.approvalToolCallId, "exit-1");

    const transition = await coordinator.resolvePlanApprovalAndStart({
      session: result.session,
      config: {} as AgentTeamConfig,
      workflowId: "main",
      permissionMode: "fullAccess"
    });
    assert.equal(transition.workflow.runId, "run-approved");
    assert.equal(transition.resolution.session.status, "running_workflow");
    assert.equal(transition.resolution.session.workflowBinding?.runId, "run-approved");
    assert.equal((capturedWorkflowInput as { approved_plan?: unknown }).approved_plan, "# Plan\n\nApprove me.");
    assert.deepEqual(capturedWorkflowOptions, {
      permissionMode: "fullAccess",
      clearContext: false,
      sessionId: planning.id
    });
    const transitionedMetadata = await store.loadMetadata(planning.id);
    assert.equal(transitionedMetadata?.currentRunId, "run-approved");
    assert.equal(transitionedMetadata?.execution?.workflowBinding?.runId, "run-approved");
  });

  it("repairs a historical dangling ExitPlanMode call before the next model request", async () => {
    const cwd = await workspace("agent-team-coordinator-repair-");
    const base = createKernelSession({
      id: "session-repair",
      cwd,
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    const planning = new PlanModeController().enterPlanMode(base, { request: "plan this" });
    const broken = {
      ...planning,
      messages: [
        { role: "user" as const, content: "plan this" },
        { role: "assistant" as const, content: "", tool_calls: [{ id: "exit-old", name: "ExitPlanMode", input: {} }] },
        { role: "user" as const, content: "continue planning" }
      ]
    };
    const provider: ModelProvider = {
      async generate(request) {
        assert.ok(request.messages.some((message) => message.role === "tool" && message.tool_call_id === "exit-old"));
        return { content: "Continuing." };
      }
    };

    const result = await new ExecutionCoordinator().executeSession({
      session: broken,
      provider,
      model: "test-model",
      tools: new ToolRegistry()
    });

    assert.equal(result.outcome.status, "completed");
    assert.equal(result.session.status, "planning");
    assert.ok(result.session.messages.some((message) => message.role === "tool" && message.tool_call_id === "exit-old"));
  });

  it("refuses to sample while a persisted interaction is unresolved", async () => {
    const cwd = await workspace("agent-team-coordinator-guard-");
    let sampled = false;
    const provider: ModelProvider = {
      async generate() {
        sampled = true;
        return { content: "unexpected" };
      }
    };
    const session = {
      ...createKernelSession({
        id: "session-guard",
        cwd,
        permissions: { mode: "default", allow: [], ask: [], deny: [] }
      }),
      status: "waiting_user_input" as const,
      pendingInteraction: {
        type: "ask_user_question" as const,
        id: "ask-pending",
        sessionId: "session-guard",
        toolCallId: "ask-pending",
        questions: []
      }
    };

    await assert.rejects(
      new ExecutionCoordinator().executeSession({ session, provider, model: "test-model", tools: new ToolRegistry() }),
      /unresolved interaction ask-pending/
    );
    assert.equal(sampled, false);
  });
});
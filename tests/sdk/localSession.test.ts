import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPlanFilePath } from "../../src/plans/planFiles.js";
import { ModelProvider } from "../../src/providers/types.js";
import { LocalHeadlessSession } from "../../src/sdk/localSession.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

describe("LocalHeadlessSession", () => {
  it("keeps Plan Mode from starting workflow before approval", async () => {
    let workflowRuns = 0;
    const session = new LocalHeadlessSession({
      sessionId: "sdk-plan",
      cwd: process.cwd(),
      model: "test-model",
      provider: readyProvider,
      planApprovalCallback: () => "stay",
      workflowStarter: () => { workflowRuns += 1; }
    });

    const entered = session.enterPlanMode({ request: "build" });
    await session.updatePlanDraft("# Plan\nDo it carefully.");
    const approval = await session.requestPlanApproval();

    assert.equal(entered.type, "plan_mode_entered");
    assert.equal(approval.decision, "stay");
    assert.equal(session.getPlanState()?.mode, "planning");
    assert.equal(workflowRuns, 0);
  });

  it("uses plan approval callback to continue and start local workflow", async () => {
    const handoffs: unknown[] = [];
    const session = new LocalHeadlessSession({
      sessionId: "sdk-plan-continue",
      cwd: process.cwd(),
      model: "test-model",
      provider: readyProvider,
      planApprovalCallback: () => "continue",
      workflowStarter: (handoff) => { handoffs.push(handoff); }
    });

    session.enterPlanMode({ request: "build" });
    await session.updatePlanDraft("# Plan\nDo it carefully.");
    const approval = await session.requestPlanApproval();

    assert.equal(approval.decision, "continue");
    assert.equal(session.getPlanState()?.mode, "inactive");
    assert.deepEqual(handoffs, [{
      original_input: { request: "build" },
      approved_plan: "# Plan\nDo it carefully.",
      plan_file_path: getPlanFilePath("sdk-plan-continue", process.cwd())
    }]);
  });

  it("runs normal local headless turns through runtime", async () => {
    const session = new LocalHeadlessSession({
      sessionId: "sdk-normal",
      cwd: process.cwd(),
      model: "test-model",
      provider: readyProvider
    });

    const result = await session.query("hello");

    assert.equal(result.status, "completed");
    assert.equal(session.getMessages().at(-1)?.content, "ready");
  });

  it("waits for approval when a Plan Mode query calls ExitPlanMode", async () => {
    const handoffs: unknown[] = [];
    const approvalRequests: unknown[] = [];
    const session = new LocalHeadlessSession({
      sessionId: "sdk-plan-query",
      cwd: process.cwd(),
      model: "test-model",
      provider: exitPlanProvider,
      tools: createLocalToolRegistry(),
      planApprovalCallback: (plan) => { approvalRequests.push(plan); return "continue"; },
      workflowStarter: (handoff) => { handoffs.push(handoff); }
    });

    session.enterPlanMode({ request: "build" });
    const result = await session.query("prepare the plan");

    assert.equal(result.status, "waiting_plan_approval");
    assert.equal(session.getPlanState()?.mode, "waiting_approval");
    assert.deepEqual(handoffs, []);

    const approval = await session.requestPlanApproval();

    assert.equal(approval.decision, "continue");
    assert.equal(session.getPlanState()?.mode, "inactive");
    assert.deepEqual(approval.events.map((event) => event.type), ["plan_approval_resolved"]);
    assert.deepEqual(approvalRequests, [{
      sessionId: "sdk-plan-query",
      document: "# Plan\nDo it carefully.",
      planFilePath: getPlanFilePath("sdk-plan-query", process.cwd()),
      requestedPermissions: [{ tool: "Bash", prompt: "run tests" }]
    }]);
    assert.deepEqual(handoffs, [{
      original_input: { request: "build" },
      approved_plan: "# Plan\nDo it carefully.",
      plan_file_path: getPlanFilePath("sdk-plan-query", process.cwd()),
      plan_requested_permissions: [{ tool: "Bash", prompt: "run tests" }]
    }]);
  });
});

const readyProvider: ModelProvider = {
  async generate() {
    return { content: "ready" };
  }
};

const exitPlanProvider: ModelProvider = {
  async generate() {
    return {
      content: "ready for approval",
      tool_calls: [{ id: "call-exit-plan", name: "ExitPlanMode", input: { plan: "# Plan\nDo it carefully.", allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] } }]
    };
  }
};

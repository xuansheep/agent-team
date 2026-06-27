import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelProvider } from "../../src/providers/types.js";
import { LocalHeadlessSession } from "../../src/sdk/localSession.js";

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
    assert.deepEqual(handoffs, [{ original_input: { request: "build" }, approved_plan: "# Plan\nDo it carefully." }]);
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
});

const readyProvider: ModelProvider = {
  async generate() {
    return { content: "ready" };
  }
};

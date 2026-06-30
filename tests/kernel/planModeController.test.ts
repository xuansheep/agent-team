import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKernelSession } from "../../src/kernel/session.js";
import { PlanModeController } from "../../src/kernel/plan/planModeController.js";
import { readPlan } from "../../src/plans/planFiles.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-plan-controller-"));
}

describe("PlanModeController", () => {
  it("uses plan file as approval source and stores hash on pending approval", async () => {
    const cwd = await workspace();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(session, { request: "build" });
    const waiting = await controller.requestPlanApproval(planning, { plan: "# Plan\n\nShip safely." });

    assert.equal(waiting.status, "waiting_plan_approval");
    assert.equal(waiting.pendingInteraction?.type, "plan_approval");
    assert.match(waiting.pendingInteraction?.id ?? "", /.+/);
    assert.match(waiting.pendingInteraction?.planHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(await readPlan(planning.planState!.planFilePath), "# Plan\n\nShip safely.");
  });

  it("continues by restoring pre-plan permissions and building approved handoff", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "acceptEdits", allow: [], ask: [], deny: [] } });
    const planning = controller.enterPlanMode(session, { request: "build" });
    const waiting = await controller.requestPlanApproval(planning, { plan: "# Plan\n\nShip safely." });
    const approvalId = waiting.pendingInteraction?.type === "plan_approval" ? waiting.pendingInteraction.id : "";
    const approved = controller.resolvePlanApproval(waiting, { decision: "continue" });
    const handoff = controller.buildApprovedPlanHandoff(approved);

    assert.equal(approved.status, "idle_input");
    assert.equal(approved.toolPermissionContext.mode, "acceptEdits");
    assert.equal(handoff.planText, "# Plan\n\nShip safely.");
    assert.equal(handoff.approvalId, approvalId);
  });

  it("stays in plan mode with feedback after rejection", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const planning = controller.enterPlanMode(session, { request: "build" });
    const waiting = await controller.requestPlanApproval(planning, { plan: "# Plan" });
    const rejected = controller.resolvePlanApproval(waiting, { decision: "stay", feedback: { answer: "add tests" } });

    assert.equal(rejected.status, "planning");
    assert.equal(rejected.toolPermissionContext.mode, "plan");
    assert.equal(rejected.planState?.feedbackMessages?.length, 1);
  });
});

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
  it("uses plan file as approval source", async () => {
    const cwd = await workspace();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(session, { request: "build" });
    const waiting = await controller.requestPlanApproval(planning, { plan: "# Plan\n\nShip safely." });

    assert.equal(waiting.status, "waiting_plan_approval");
    assert.equal(waiting.pendingInteraction?.type, "plan_approval");
    assert.equal(await readPlan(planning.planState!.planFilePath), "# Plan\n\nShip safely.");
  });
});

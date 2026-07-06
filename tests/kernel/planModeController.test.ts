import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKernelSession } from "../../src/kernel/session.js";
import { PlanModeController } from "../../src/kernel/plan/planModeController.js";
import { readPlan, writePlan } from "../../src/plans/planFiles.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-plan-controller-"));
}

describe("PlanModeController", () => {
  it("uses plan file as approval source and stores hash on pending approval", async () => {
    const cwd = await workspace();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(session, { request: "build" });
    await writePlan(planning.planState!.planFilePath, "# Plan\n\nShip safely.");
    const waiting = await controller.requestPlanApproval(planning);

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
    await writePlan(planning.planState!.planFilePath, "# Plan\n\nShip safely.");
    const waiting = await controller.requestPlanApproval(planning);
    const approvalId = waiting.pendingInteraction?.type === "plan_approval" ? waiting.pendingInteraction.id : "";
    await writePlan(planning.planState!.planFilePath, "# Plan\n\nUpdated after review opened.");
    const approved = (await controller.resolvePlanApproval(waiting, { decision: "continue" })).session;
    const handoff = controller.buildApprovedPlanHandoff(approved);

    assert.equal(approved.status, "idle_input");
    assert.equal(approved.toolPermissionContext.mode, "acceptEdits");
    assert.equal(handoff.planText, "# Plan\n\nUpdated after review opened.");
    assert.equal(handoff.approvalId, approvalId);
  });

  it("stays in plan mode with feedback after rejection", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const planning = controller.enterPlanMode(session, { request: "build" });
    await writePlan(planning.planState!.planFilePath, "# Plan");
    const waiting = await controller.requestPlanApproval(planning);
    const rejected = (await controller.resolvePlanApproval(waiting, { decision: "stay", feedback: { answer: "add tests" } })).session;

    assert.equal(rejected.status, "planning");
    assert.equal(rejected.toolPermissionContext.mode, "plan");
    assert.equal(rejected.planState?.feedbackMessages?.length, 1);
  });

  it("closes the ExitPlanMode tool call when plan approval is rejected", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const planning = controller.enterPlanMode({
      ...session,
      messages: [{ role: "assistant", content: "", tool_calls: [{ id: "exit-plan", name: "ExitPlanMode", input: {} }] }]
    }, { request: "build" });
    await writePlan(planning.planState!.planFilePath, "# Plan");
    const waiting = await controller.requestPlanApproval(planning, { toolCallId: "exit-plan" });
    const rejected = (await controller.resolvePlanApproval(waiting, { decision: "stay", feedback: "add tests" })).session;

    assert.equal(rejected.pendingInteraction, null);
    assert.deepEqual(rejected.messages.at(-1), {
      role: "tool",
      tool_call_id: "exit-plan",
      content: "Plan approval was rejected by the user. Stay in Plan Mode, incorporate the feedback, update the plan file, then call ExitPlanMode again.\nUser feedback: add tests"
    });
  });
  it("requests plan approval from the plan file without accepting request plan text", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = createKernelSession({ id: "kernel-plan-file", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const planning = controller.enterPlanMode(session, { request: "build" });
    assert.ok(planning.planState);
    await writePlan(planning.planState.planFilePath, "# Kernel Plan\n\nRead from disk.\n");

    const waiting = await controller.requestPlanApproval(planning, { requestedPermissions: [{ tool: "Bash", prompt: "run tests" }] });

    assert.equal(waiting.pendingInteraction?.type, "plan_approval");
    assert.equal("document" in waiting.pendingInteraction, false);
    assert.equal(waiting.pendingInteraction?.planFilePath, planning.planState.planFilePath);
    assert.deepEqual(waiting.pendingInteraction?.requestedPermissions, [{ tool: "Bash", prompt: "run tests" }]);
  });

  it("resolves plan approval with clear-context metadata", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = controller.enterPlanMode(createKernelSession({
      id: "approval-clear-context",
      cwd,
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    }), { request: "build" });
    assert.ok(session.planState);
    await writePlan(session.planState.planFilePath, "# Plan\n\nClear context.\n");
    const waiting = await controller.requestPlanApproval(session);

    const resolved = await controller.resolvePlanApproval(waiting, {
      decision: "continue",
      permissionMode: "auto",
      clearContext: true,
      feedback: "Run focused tests."
    });

    assert.equal(resolved.execution?.clearContext, true);
    assert.equal(resolved.execution?.permissionMode, "auto");
    assert.match(resolved.execution?.initialInput ?? "", /Implement the following plan:/);
    assert.match(resolved.execution?.initialInput ?? "", /Clear context\./);
    assert.match(resolved.execution?.initialInput ?? "", /Run focused tests\./);
  });

});

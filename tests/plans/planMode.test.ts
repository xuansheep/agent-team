import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";
import { approvePlan, buildApprovedPlanHandoff, enterPlanMode, exitPlanMode, resolvePlanApproval, runWorkflowAfterPlanApproval } from "../../src/plans/planSession.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { PlanSessionState } from "../../src/plans/planSession.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-plan-mode-"));
}

describe("Plan Mode V2", () => {
  it("returns stable non-conflicting plan file paths per session", async () => {
    const cwd = await workspace();
    const first = getPlanFilePath("session/one", cwd);
    const again = getPlanFilePath("session/one", cwd);
    const other = getPlanFilePath("session-one", cwd);

    assert.equal(first, again);
    assert.notEqual(first, other);
    assert.match(first, /[.]session[\\/]plans[\\/].+[.]md$/);
  });

  it("writes and reads plan drafts", async () => {
    const cwd = await workspace();
    const path = getPlanFilePath("session-1", cwd);
    const draft = "# Plan\n\n1. Think first.\n";

    assert.equal(await readPlan(path), undefined);
    await writePlan(path, draft);
    assert.equal(await readPlan(path), draft);
  });

  it("enters plan mode from default and records pre mode plus original input", async () => {
    const cwd = await workspace();
    const result = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: ["Read"], ask: [], deny: [] }
    });

    assert.equal(result.state.mode, "planning");
    assert.equal(result.state.prePlanMode, "default");
    assert.deepEqual(result.state.originalInput, { request: "build" });
    assert.equal(result.permissions.mode, "plan");
    assert.equal(result.permissions.prePlanMode, "default");
    assert.equal(result.permissions.planFilePath, result.state.planFilePath);
    assert.deepEqual(result.event, { type: "plan_mode_entered", session_id: "session-1", plan_file_path: result.state.planFilePath });
  });

  it("does not run workflow before plan approval", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    let workflowRuns = 0;

    await assert.rejects(() => runWorkflowAfterPlanApproval(state, async () => {
      workflowRuns += 1;
      return "ran";
    }), /approved/);
    assert.equal(workflowRuns, 0);
  });

  it("allows only current plan file writes in plan mode", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const { state, permissions } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    const currentPlanInput = { file_path: state.planFilePath.slice(cwd.length + 1), content: "# Plan" };

    assert.equal((await checkToolPermission(tools.get("Write"), currentPlanInput, { ...permissions, cwd })).decision, "allow");
    assert.equal((await checkToolPermission(tools.get("Write"), { file_path: "README.md", content: "x" }, { ...permissions, cwd })).decision, "deny");
  });

  it("returns an auditable error when exiting without a non-empty plan", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });

    await assert.rejects(() => exitPlanMode(state), /empty or missing/);
  });

  it("requests approval when exiting with a plan draft", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    await writePlan(state.planFilePath, "# Plan\n\nDo it.\n");

    const result = await exitPlanMode(state);

    assert.equal(result.state.mode, "waiting_approval");
    assert.equal(result.plan.sessionId, "session-1");
    assert.equal(result.plan.document, "# Plan\n\nDo it.");
    assert.equal(result.plan.planFilePath, state.planFilePath);
    assert.deepEqual(result.event, { type: "plan_approval_requested", session_id: "session-1", document: "# Plan\n\nDo it.", plan_file_path: state.planFilePath });
  });

  it("restores pre mode and injects approved plan into workflow handoff", async () => {
    const cwd = await workspace();
    const entered = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "acceptEdits", allow: [], ask: [], deny: [] }
    });
    const approved = approvePlan(entered.state, "# Plan\nBuild it.");
    const resolved = resolvePlanApproval(approved, "continue");

    assert.equal(resolved.state.mode, "inactive");
    assert.equal(resolved.permissions.mode, "acceptEdits");
    assert.deepEqual(resolved.event, { type: "plan_approval_resolved", session_id: "session-1", decision: "continue" });
    assert.deepEqual(buildApprovedPlanHandoff(resolved.state), { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it." });

    let workflowRuns = 0;
    const result = await runWorkflowAfterPlanApproval(resolved.state, async (handoff) => {
      workflowRuns += 1;
      return handoff;
    });
    assert.equal(workflowRuns, 1);
    assert.deepEqual(result, { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it." });
  });

  it("keeps plan mode after rejection and stores user feedback", async () => {
    const cwd = await workspace();
    const entered = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });

    const result = resolvePlanApproval({ ...entered.state, mode: "waiting_approval" }, "stay", { answer: "split it smaller" });

    assert.equal(result.state.mode, "planning");
    assert.equal(result.permissions.mode, "plan");
    assert.deepEqual(result.event, { type: "plan_approval_resolved", session_id: "session-1", decision: "stay" });
    assert.deepEqual(result.state.feedbackMessages, [{ answer: "split it smaller" }]);
  });

  it("executes EnterPlanMode and ExitPlanMode tools", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    const entered = await tools.get("EnterPlanMode").execute({
      sessionId: "session-tool",
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    }, { cwd });
    const enteredData = entered.data as { state: PlanSessionState; permissions: { mode: string; planFilePath?: string } };

    assert.equal(enteredData.state.mode, "planning");
    assert.equal(enteredData.permissions.mode, "plan");

    await writePlan(enteredData.state.planFilePath, "# Plan\nTool path.\n");
    const exited = await tools.get("ExitPlanMode").execute({ state: enteredData.state }, { cwd });
    const exitedData = exited.data as { state: PlanSessionState; plan: { document: string } };

    assert.equal(exitedData.state.mode, "waiting_approval");
    assert.match(exitedData.plan.document, /Tool path/);
    assert.equal((exited.data as { event: { type: string } }).event.type, "plan_approval_requested");
  });

});

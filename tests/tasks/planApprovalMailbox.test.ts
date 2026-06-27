import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanApprovalMailbox } from "../../src/tasks/planApprovalMailbox.js";
import { TaskRegistry } from "../../src/tasks/taskRegistry.js";

describe("PlanApprovalMailbox", () => {
  it("stores teammate plan approval requests and resolves them", () => {
    const mailbox = new PlanApprovalMailbox();
    const request = mailbox.submit({
      requesterTaskId: "task-1",
      plan: { sessionId: "child-session", document: "# Plan", planFilePath: ".session/plans/child.md" }
    });

    assert.equal(request.status, "pending");
    assert.equal(mailbox.listPending().length, 1);

    const approved = mailbox.approve(request.id);
    assert.equal(approved.status, "approved");
    assert.equal(mailbox.listPending().length, 0);
    assert.throws(() => mailbox.reject(request.id, "too broad"), /already approved/);
  });

  it("lets a task wait on a submitted plan approval request", async () => {
    const mailbox = new PlanApprovalMailbox();
    const registry = new TaskRegistry();
    registry.register("teammate-plan", async (task) => {
      const approval = mailbox.submit({
        requesterTaskId: task.id,
        plan: { sessionId: `${task.id}:agent`, document: "# Plan", planFilePath: ".session/plans/agent.md" }
      });
      return { status: "waiting_plan_approval", planApprovalId: approval.id, result: approval.plan };
    });

    const task = registry.startTask({ kind: "teammate-plan" }, { cwd: process.cwd() });
    const waiting = await registry.waitForTask(task.id);

    assert.equal(waiting.status, "waiting_plan_approval");
    assert.equal(waiting.planApprovalId, mailbox.listPending()[0]?.id);
  });
});

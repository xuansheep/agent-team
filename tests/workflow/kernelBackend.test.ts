import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowBackend } from "../../src/kernel/workflow/workflowBackend.js";
import type { ApprovedPlanHandoff } from "../../src/kernel/plan/planModeController.js";

describe("WorkflowBackend", () => {
  it("starts once per approval id and plan hash", async () => {
    const starts: unknown[] = [];
    const backend = new WorkflowBackend({
      startWorkflow: async (handoff) => {
        starts.push(handoff);
        return { runId: "run-1", status: "running" as const };
      }
    });
    const handoff: ApprovedPlanHandoff = {
      sessionId: "s1",
      approvalId: "approval-1",
      planFilePath: ".session/plans/s1.md",
      planText: "# Plan",
      planHash: "a".repeat(64),
      originalInput: { request: "build" },
      legacyHandoff: { original_input: { request: "build" }, approved_plan: "# Plan" }
    };

    assert.equal((await backend.startOrResume(handoff)).runId, "run-1");
    assert.equal((await backend.startOrResume(handoff)).runId, "run-1");
    assert.equal(starts.length, 1);
  });
});

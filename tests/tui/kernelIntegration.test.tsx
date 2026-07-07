import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession, reduceKernelSession } from "../../src/kernel/session.js";
import { createTuiKernelAdapter } from "../../src/tui/kernelAdapter.js";

describe("TUI kernel adapter", () => {
  it("projects plan approval pending interaction and resolve intents", () => {
    const session = reduceKernelSession(createKernelSession({
      id: "s1",
      cwd: process.cwd(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" }
    }), {
      type: "pending_interaction_set",
      interaction: { type: "plan_approval", id: "approval-1", sessionId: "s1", planFilePath: ".session/plans/s1.md", planHash: "hash-1" }
    });

    const adapter = createTuiKernelAdapter(session);
    assert.equal(adapter.appState.status, "waiting_plan_approval");
    assert.equal(adapter.planReview?.planFilePath, ".session/plans/s1.md");
    assert.equal(adapter.planReview && "document" in adapter.planReview, false);
    assert.deepEqual(adapter.planApprovalIntent("continue"), { type: "resolve_plan_approval", decision: "continue" });
    assert.deepEqual(adapter.planApprovalIntent("stay", { feedback: { answer: "more tests" } }), {
      type: "resolve_plan_approval",
      decision: "stay",
      metadata: { feedback: { answer: "more tests" } }
    });
    assert.deepEqual(adapter.planApprovalIntent("continue", { permissionMode: "fullAccess", clearContext: true, feedback: "ok" }), {
      type: "resolve_plan_approval",
      decision: "continue",
      metadata: { permissionMode: "fullAccess", clearContext: true, feedback: "ok" }
    });
  });
});

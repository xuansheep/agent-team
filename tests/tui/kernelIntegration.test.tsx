import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession, reduceKernelSession } from "../../src/kernel/session.js";
import { createTuiKernelAdapter } from "../../src/tui/kernelAdapter.js";

describe("TUI kernel adapter", () => {
  it("projects plan approval pending interaction", () => {
    const session = reduceKernelSession(createKernelSession({
      id: "s1",
      cwd: process.cwd(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" }
    }), {
      type: "pending_interaction_set",
      interaction: { type: "plan_approval", id: "approval-1", sessionId: "s1", document: "# Plan", planFilePath: ".session/plans/s1.md" }
    });

    const adapter = createTuiKernelAdapter(session);
    assert.equal(adapter.appState.status, "waiting_plan_approval");
    assert.equal(adapter.planReview?.document, "# Plan");
  });
});

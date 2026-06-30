import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession, projectAppState, reduceKernelSession } from "../../src/kernel/session.js";

const permissions = { mode: "default" as const, allow: [], ask: [], deny: [] };

describe("KernelSession", () => {
  it("stores one pending plan approval", () => {
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions });
    const next = reduceKernelSession(session, {
      type: "pending_interaction_set",
      interaction: { type: "plan_approval", id: "approval-1", sessionId: "s1", planFilePath: ".session/plans/s1.md", document: "# Plan\n" }
    });

    assert.equal(next.status, "waiting_plan_approval");
    assert.equal(next.pendingInteraction?.type, "plan_approval");
    assert.equal(projectAppState(next).messageCount, 0);
  });
});

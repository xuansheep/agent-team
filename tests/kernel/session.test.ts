import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createKernelSession,
  reduceKernelSession,
  restoreKernelSession,
  snapshotKernelSession,
  type KernelIntent
} from "../../src/kernel/session.js";
import { projectKernelAppState } from "../../src/kernel/appState.js";

const permissions = { mode: "default" as const, allow: [], ask: [], deny: [] };

describe("KernelSession", () => {
  it("stores pending plan approval as restorable kernel state", () => {
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions });
    const next = reduceKernelSession(session, {
      type: "pending_interaction_set",
      interaction: {
        type: "plan_approval",
        id: "approval-1",
        sessionId: "s1",
        planFilePath: ".session/plans/s1.md",
        document: "# Plan\n",
        planHash: "hash-1",
        requestedPermissions: []
      }
    });

    const restored = restoreKernelSession(snapshotKernelSession(next));
    assert.equal(restored.status, "waiting_plan_approval");
    assert.equal(restored.pendingInteraction?.type, "plan_approval");
    assert.equal(projectKernelAppState(restored).pendingInteraction?.type, "plan_approval");
    assert.equal(projectKernelAppState(restored).permissionMode, "default");
  });

  it("applies user message intent through the reducer", () => {
    const intent: KernelIntent = { type: "submit_user_message", content: "plan this" };
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions });
    const next = reduceKernelSession(session, { type: "intent_applied", intent });

    assert.equal(next.messages.at(-1)?.role, "user");
    assert.equal(next.messages.at(-1)?.content, "plan this");
  });
});

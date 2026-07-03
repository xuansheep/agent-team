import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionIndex } from "../../src/storage/sessionIndex.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { RunStore } from "../../src/storage/runStore.js";
import { PlanSessionState } from "../../src/plans/planSession.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-session-store-"));
}

describe("SessionStore", () => {
  it("saves and loads transcript messages by session id", async () => {
    const root = await workspace();
    const store = new SessionStore(root);

    await store.appendTranscript("session-1", { role: "user", content: "hello" });
    await store.appendTranscript("session-1", { role: "assistant", content: "ready" });

    const transcript = await store.loadTranscript("session-1");
    assert.deepEqual(transcript.map((entry) => entry.message.role), ["user", "assistant"]);
    assert.equal(transcript[0]?.message.content, "hello");
  });

  it("rebuilds the session index from metadata when the root index is missing", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    await store.saveMetadata("session-1", { workflowRunId: "run-1", status: "planning" });
    await store.saveMetadata("session-2", { workflowRunId: "run-2", status: "completed" });

    const entries = await new SessionIndex(root).rebuildFromMetadata();

    assert.deepEqual(entries.map((entry) => entry.sessionId).sort(), ["session-1", "session-2"]);
    assert.equal((await new SessionIndex(root).list()).length, 2);
  });

  it("recovers Plan Mode state from session metadata", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    const planState: PlanSessionState = {
      mode: "planning",
      sessionId: "session-plan",
      planFilePath: getPlanFilePath("session-plan", root),
      prePlanMode: "acceptEdits",
      originalInput: { request: "build" },
      feedbackMessages: [{ answer: "split it" }]
    };

    await store.savePlanState("session-plan", planState);
    const restored = await store.loadPlanState("session-plan");

    assert.deepEqual(restored, planState);
  });

  it("preserves Plan Mode metadata when transcript appends happen concurrently", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    const planState: PlanSessionState = {
      mode: "planning",
      sessionId: "session-plan-race",
      planFilePath: getPlanFilePath("session-plan-race", root),
      prePlanMode: "default",
      originalInput: { request: "build" },
      feedbackMessages: []
    };

    await Promise.all([
      store.savePlanState("session-plan-race", planState),
      store.appendTranscript("session-plan-race", { role: "user", content: "hello" })
    ]);

    assert.deepEqual(await store.loadPlanState("session-plan-race"), planState);
  });

  it("keeps plan files recoverable with restored Plan Mode metadata", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    const planFilePath = getPlanFilePath("session-plan", root);
    const planState: PlanSessionState = {
      mode: "waiting_approval",
      sessionId: "session-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "build" }
    };

    await writePlan(planFilePath, "# Plan\nDo it.\n");
    await store.savePlanState("session-plan", planState);

    assert.equal((await store.loadPlanState("session-plan"))?.planFilePath, planFilePath);
    assert.equal(await readPlan(planFilePath), "# Plan\nDo it.\n");
  });

  it("records prompt injection metadata without storing prompt text", async () => {
    const root = await workspace();
    const store = new SessionStore(root);

    await store.saveMetadata("session-prompt", {
      promptInjection: {
        globalPrompt: {
          type: "global_prompt",
          recordedAt: "2026-07-03T00:00:00.000Z",
          available: true,
          presentInRequest: true,
          injectedThisTurn: true,
          sha256: "global-hash",
          chars: 23,
          lines: 1,
          sources: [{ kind: "project_agents", path: join(root, ".agents", "AGENTS.md"), sha256: "source-hash", chars: 23, lines: 1 }]
        }
      }
    });

    const metadata = await store.loadMetadata("session-prompt");

    assert.equal(metadata?.promptInjection?.globalPrompt?.presentInRequest, true);
    assert.equal(metadata?.promptInjection?.globalPrompt?.sources?.[0]?.kind, "project_agents");
    assert.equal(JSON.stringify(metadata?.promptInjection).includes("Secret prompt"), false);
  });
});

describe("RunStore index compatibility", () => {
  it("lists runs from the root index before scanning legacy run directories", async () => {
    const root = await workspace();
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "indexed request" });
    await store.saveState(run.runId, { status: "completed", workflow_id: "delivery", attempts: [] });
    await writeFile(join(run.runDir, "state.json"), "not-json", "utf8");

    const runs = await store.listRuns();

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.runId, run.runId);
    assert.equal(runs[0]?.status, "completed");
    assert.match(runs[0]?.inputPreview ?? "", /indexed request/);
  });

  it("falls back to scanning legacy run directories when no run index exists", async () => {
    const root = await workspace();
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "legacy request" });
    await store.saveState(run.runId, { status: "pending", workflow_id: "delivery", current_node_id: "product", attempts: [] });
    await writeFile(join(root, "index.json"), JSON.stringify({ version: 1, sessions: [] }, null, 2), "utf8");

    const runs = await store.listRuns();

    assert.equal(runs[0]?.runId, run.runId);
    assert.equal(runs[0]?.currentNodeId, "product");
  });
});

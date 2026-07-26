import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { RunStore } from "../../src/storage/runStore.js";
import { PlanSessionState } from "../../src/plans/planSession.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";
import { createKernelSession } from "../../src/kernel/session.js";

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

  it("labels plan entries and deduplicates workflow transcript entries", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    const workflowEntry = {
      message: { role: "assistant" as const, content: "workflow result" },
      runId: "run-1",
      entryId: "workflow:run-1:node:dev:attempt:1:message:0"
    };

    await store.appendTranscript("session-1", { role: "user", content: "plan request" });
    await store.appendWorkflowTranscriptEntries("session-1", [workflowEntry]);
    await store.appendWorkflowTranscriptEntries("session-1", [workflowEntry]);

    const transcript = await store.loadTranscript("session-1");
    assert.deepEqual(transcript.map((entry) => entry.phase), ["plan", "workflow"]);
    assert.equal(transcript.filter((entry) => entry.entryId === workflowEntry.entryId).length, 1);
  });

  it("lists sessions directly from session metadata", async () => {
    const root = await workspace();
    const store = new SessionStore(root);
    await store.saveMetadata("session-1", { inputPreview: "first" });
    await store.saveMetadata("session-2", { inputPreview: "second" });
    await store.attachRun("session-1", "run-1");
    await store.attachRun("session-2", "run-2");

    const entries = await store.listSessions();

    assert.deepEqual(entries.map((entry) => entry.sessionId).sort(), ["session-1", "session-2"]);
    assert.deepEqual(entries.map((entry) => entry.currentRunId).sort(), ["run-1", "run-2"]);
  });

  it("recovers Plan Mode state from session metadata", async () => {
    const root = await workspace();
    const store = new SessionStore(join(root, ".session"));
    const planState: PlanSessionState = {
      mode: "planning",
      sessionId: "session-plan",
      planFilePath: getPlanFilePath("session-plan", root),
      prePlanMode: "fullAccess",
      originalInput: { request: "build" },
      feedbackMessages: [{ answer: "split it" }]
    };

    await store.savePlanState("session-plan", planState);
    const restored = await store.loadPlanState("session-plan");

    assert.deepEqual(restored, planState);
  });

  it("preserves Plan Mode metadata when transcript appends happen concurrently", async () => {
    const root = await workspace();
    const store = new SessionStore(join(root, ".session"));
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
    const store = new SessionStore(join(root, ".session"));
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
          sources: [{ kind: "project_agents", path: join(root, ".einsteins", "AGENTS.md"), sha256: "source-hash", chars: 23, lines: 1 }]
        }
      }
    });

    const metadata = await store.loadMetadata("session-prompt");

    assert.equal(metadata?.promptInjection?.globalPrompt?.presentInRequest, true);
    assert.equal(metadata?.promptInjection?.globalPrompt?.sources?.[0]?.kind, "project_agents");
    assert.equal(JSON.stringify(metadata?.promptInjection).includes("Secret prompt"), false);
  });
});

describe("RunStore session hierarchy", () => {
  it("keeps the bound Session status aligned with Run completion and continuation", async () => {
    const root = await workspace();
    const runs = new RunStore(root);
    const sessions = new SessionStore(root);
    const run = await runs.createRun("delivery", { request: "start" }, { sessionId: "session-status" });
    const base = createKernelSession({
      id: "session-status",
      cwd: root,
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    await sessions.saveKernelCheckpoint({
      ...base,
      status: "running_workflow",
      workflowBinding: {
        runId: run.runId,
        status: "running",
        approvalId: "approval-1",
        planHash: "plan-hash-1"
      }
    });

    await runs.appendEvent(run.runId, { type: "run_completed", result: { status: "completed" } });

    const completed = await sessions.loadMetadata("session-status");
    assert.equal(completed?.execution?.status, "idle_input");
    assert.equal(completed?.execution?.workflowBinding?.status, "completed");
    assert.equal(completed?.execution?.workflowBinding?.approvalId, "approval-1");
    assert.equal(completed?.execution?.workflowBinding?.planHash, "plan-hash-1");
    assert.equal(completed?.execution?.pendingInteraction, null);

    await runs.appendEvent(run.runId, {
      type: "run_continued",
      workflow_id: "delivery",
      input: { request: "continue" }
    });

    const continued = await sessions.loadMetadata("session-status");
    assert.equal(continued?.execution?.status, "running_workflow");
    assert.equal(continued?.execution?.workflowBinding?.status, "running");

    await runs.appendEvent(run.runId, { type: "run_completed", result: { status: "completed" } });
    await runs.appendEvent(run.runId, { type: "user_message", text: "continue again" });

    const messaged = await sessions.loadMetadata("session-status");
    assert.equal(messaged?.execution?.status, "running_workflow");
    assert.equal(messaged?.execution?.workflowBinding?.status, "running");
    assert.equal(messaged?.execution?.workflowBinding?.approvalId, "approval-1");
    assert.equal(messaged?.execution?.workflowBinding?.planHash, "plan-hash-1");
  });

  it("does not let an old Run completion overwrite the current bound Run status", async () => {
    const root = await workspace();
    const runs = new RunStore(root);
    const sessions = new SessionStore(root);
    const oldRun = await runs.createRun("delivery", { request: "old" }, { sessionId: "session-current-run" });
    const currentRun = await runs.createRun("delivery", { request: "current" }, { sessionId: "session-current-run" });
    const base = createKernelSession({
      id: "session-current-run",
      cwd: root,
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    await sessions.saveKernelCheckpoint({
      ...base,
      status: "running_workflow",
      workflowBinding: { runId: currentRun.runId, status: "running" }
    });

    await runs.appendEvent(oldRun.runId, { type: "run_completed", result: { status: "completed" } });

    const metadata = await sessions.loadMetadata("session-current-run");
    assert.equal(metadata?.currentRunId, currentRun.runId);
    assert.equal(metadata?.execution?.status, "running_workflow");
    assert.equal(metadata?.execution?.workflowBinding?.runId, currentRun.runId);
    assert.equal(metadata?.execution?.workflowBinding?.status, "running");
  });

  it("links runs to sessions, records workflow dialogue once, and ignores stream deltas for activity time", async () => {
    const root = await workspace();
    const runs = new RunStore(root);
    const sessions = new SessionStore(root);
    const run = await runs.createRun("delivery", { request: "session request" }, { sessionId: "session-workflow" });

    const createdMetadata = await sessions.loadMetadata("session-workflow");
    assert.equal(createdMetadata?.currentRunId, run.runId);
    assert.deepEqual(createdMetadata?.runIds, [run.runId]);

    const initialTranscript = await sessions.loadTranscript("session-workflow");
    assert.equal(initialTranscript[0]?.phase, "workflow");
    assert.equal(initialTranscript[0]?.message.content, "session request");
    const activityBeforeDelta = createdMetadata?.lastActivityAt;

    await runs.appendEvent(run.runId, { type: "model_stream_delta", node_id: "dev", attempt: 1, text: "partial" });
    assert.equal((await sessions.loadMetadata("session-workflow"))?.lastActivityAt, activityBeforeDelta);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runs.appendEvent(run.runId, { type: "node_started", node_id: "dev", attempt: 1 });
    const activityAfterNodeStart = (await sessions.loadMetadata("session-workflow"))?.lastActivityAt;
    assert.equal(activityAfterNodeStart, activityBeforeDelta);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runs.appendEvent(run.runId, { type: "run_completed", result: { status: "completed" } });
    const activityAfterCompletion = (await sessions.loadMetadata("session-workflow"))?.lastActivityAt;
    assert.ok(Date.parse(activityAfterCompletion ?? "") > Date.parse(activityBeforeDelta ?? ""));

    const dialogue = [
      { role: "system" as const, content: "internal prompt" },
      { role: "assistant" as const, content: "working" },
      { role: "user" as const, content: "internal repair prompt" },
      { role: "tool" as const, tool_call_id: "call-1", content: "done" }
    ];
    await runs.syncWorkflowDialogue(run.runId, "dev", 1, dialogue);
    await runs.syncWorkflowDialogue(run.runId, "dev", 1, dialogue);

    const transcript = await sessions.loadTranscript("session-workflow");
    assert.deepEqual(transcript.map((entry) => entry.message.role), ["user", "assistant", "tool"]);
    assert.equal(transcript.some((entry) => entry.message.content === "internal prompt"), false);
    assert.equal(transcript.some((entry) => entry.message.content === "internal repair prompt"), false);
  });

  it("lists a run using the durable state backup when the primary state is corrupt", async () => {
    const root = await workspace();
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "indexed request" });
    await store.saveState(run.runId, { version: 2, status: "completed", workflow_id: "delivery", attempts: [], node_checkpoints: {}, suspended_stack: [], rework_count: 0, rework_limit: 10 });
    await writeFile(join(run.runDir, "state.json"), "not-json", "utf8");

    const runs = await store.listRuns();

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.runId, run.runId);
    assert.equal(runs[0]?.status, "completed");
    assert.match(runs[0]?.inputPreview ?? "", /indexed request/);
  });

  it("lists runs by scanning nested session directories", async () => {
    const root = await workspace();
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "scanned request" });
    await store.saveState(run.runId, { version: 2, status: "waiting_user", workflow_id: "delivery", current_node_id: "product", attempts: [], node_checkpoints: {}, suspended_stack: [], rework_count: 0, rework_limit: 10 });
    const runs = await store.listRuns();

    assert.equal(runs[0]?.runId, run.runId);
    assert.equal(runs[0]?.currentNodeId, "product");
  });
});

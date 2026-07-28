import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../../src/storage/runStore.js";
import type { ModelMessage } from "../../src/providers/types.js";
import type { WorkflowState } from "../../src/workflow/state.js";

describe("RunStore", () => {
  it("stores runs directly below the owning session", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-run-layout-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "build it" }, { sessionId: "session-1" });
    assert.equal(run.runDir, join(root, "session-1", "runs", run.runId));
  });
  it("creates a run directory and appends ndjson events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runs-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "build it" });
    assert.equal(run.sessionId, run.runId);
    assert.match(run.sessionId, /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(run.sessionId, /^\d{2}T\d{6}-/);

    await store.appendEvent(run.runId, { type: "node_started", node_id: "product", attempt: 1 });
    await store.saveState(run.runId, workflowState({ status: "running", workflow_id: "delivery", current_node_id: "product" }));

    const events = await readFile(join(run.runDir, "events.ndjson"), "utf8");
    assert.match(events, /run_started/);
    assert.match(events, /node_started/);

    const state = JSON.parse(await readFile(join(run.runDir, "state.json"), "utf8"));
    assert.equal(state.current_node_id, "product");
    assert.equal(state.version, 5);
    assert.equal(state.session_id, run.sessionId);
    assert.equal(state.run_id, run.runId);
    assert.equal(state.revision, 1);
    assert.equal(typeof state.updated_at, "string");
  });

  it("persists managed process lifecycle events into the audit chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-managed-process-audit-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "serve" }, { sessionId: "session-process" });

    await store.appendEvent(run.runId, {
      type: "managed_process_started",
      node_id: "developer",
      attempt: 1,
      process_id: "process-1",
      pid: 1234,
      executable: "node"
    });
    await store.appendEvent(run.runId, {
      type: "managed_process_stopped",
      node_id: "developer",
      attempt: 1,
      process_id: "process-1",
      pid: 1234,
      reason: "node_complete",
      exit_code: 0
    });

    const audit = (await readFile(join(run.runDir, "..", "..", "audit.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; action?: string; process_id?: string });
    assert.deepEqual(
      audit.filter((event) => event.type === "managed_process").map((event) => `${event.action}:${event.process_id}`),
      ["started:process-1", "stopped:process-1"]
    );
  });

  it("lists run summaries newest first and skips unreadable runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-list-runs-"));
    const store = new RunStore(root);

    const first = await store.createRun("delivery", { request: "first workflow request" });
    await store.saveState(first.runId, workflowState({ status: "completed", workflow_id: "delivery" }));

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.createRun("audit", { request: "second workflow request with a long body" });
    await store.saveState(second.runId, workflowState({ status: "waiting_user", workflow_id: "audit", current_node_id: "product" }));

    await mkdir(join(root, "broken-run"));
    await writeFile(join(root, "broken-run", "state.json"), "not-json", "utf8");

    const runs = await store.listRuns();

    assert.equal(runs[0]?.runId, second.runId);
    assert.equal(runs[0]?.workflowId, "audit");
    assert.equal(runs[0]?.status, "waiting_user");
    assert.equal(runs[0]?.currentNodeId, "product");
    assert.match(runs[0]?.inputPreview ?? "", /second workflow request/);
    assert.deepEqual(runs.map((run) => run.runId), [second.runId, first.runId]);
  });

  it("returns an empty run list when the run root does not exist", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "agent-team-empty-runs-")), "missing");
    const store = new RunStore(root);

    assert.deepEqual(await store.listRuns(), []);
  });

  it("falls back to the previous complete state when the primary state is corrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-state-backup-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "x" });
    await store.saveState(run.runId, workflowState({ status: "running", workflow_id: "delivery", current_node_id: "product" }));
    await store.saveState(run.runId, workflowState({ status: "completed", workflow_id: "delivery" }));
    await writeFile(join(run.runDir, "state.json"), "{", "utf8");

    const recovered = await store.loadState(run.runId);

    assert.equal(recovered.status, "running");
    assert.equal(recovered.current_node_id, "product");
  });

  it("rejects pre-v5 workflow state without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-state-v3-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "x" });
    const messages = [
      { role: "assistant" as const, content: "working" },
      { role: "tool" as const, tool_call_id: "call-1", content: "done" }
    ];
    await writeFile(join(run.runDir, "state.json"), `${JSON.stringify({
      version: 3,
      status: "paused",
      workflow_id: "delivery",
      current_node_id: "product",
      attempts: [],
      resume_checkpoint: { node_id: "product", handoff: {}, attempt: 1, activation: 1, dialogue_messages: messages },
      node_checkpoints: {},
      suspended_stack: [],
      rework_count: 0,
      rework_limit: 10
    })}\n`, "utf8");

    await assert.rejects(() => store.loadState(run.runId), /Unsupported workflow state version 3; start a new run/);
    const persisted = JSON.parse(await readFile(join(run.runDir, "state.json"), "utf8")) as WorkflowState;
    const entries = await readdir(run.runDir);

    assert.equal(persisted.version, 3);
    assert.deepEqual(persisted.resume_checkpoint?.dialogue_messages, messages);
    assert.equal(entries.includes("run.lease"), false);
    assert.equal(entries.includes(".lease-history"), false);
  });

  it("replays append-only Codex replacement checkpoints with window lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-dialogue-compact-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "x" });
    const messages: ModelMessage[] = [
      { role: "assistant", content: "read one", tool_calls: [{ id: "read-1", name: "Read", input: { path: "one.ts" } }] },
      { role: "tool", tool_call_id: "read-1", content: "original one" },
      { role: "assistant", content: "read two", tool_calls: [{ id: "read-2", name: "Read", input: { path: "two.ts" } }] },
      { role: "tool", tool_call_id: "read-2", content: "original two" }
    ];
    assert.equal(await store.syncWorkflowDialogue(run.runId, "dev", 1, messages), 4);

    const summaryMessage: ModelMessage = {
      role: "user",
      content: "compacted summary",
      metadata: { compactSummary: true, userMessageKind: "compaction" }
    };
    const full = await store.compactWorkflowDialogue(run.runId, "dev", 1, {
      replacementHistory: [summaryMessage],
      phase: "mid_turn",
      reason: "threshold",
      model: "test-model",
      compactionHash: "hash-1",
      contextWindow: 100_000
    });
    assert.equal(full.cursor, 5);
    assert.deepEqual(full.messages, [summaryMessage]);
    assert.equal(full.window.windowNumber, 1);
    assert.equal(full.window.previousWindowId, full.window.firstWindowId);
    assert.match(full.window.currentWindowId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const beforeCompact = await store.loadWorkflowDialogueState(run.runId, "dev", 1, 4);
    assert.deepEqual(beforeCompact.messages, messages);
    const reloaded = await new RunStore(root).loadWorkflowDialogueState(run.runId, "dev", 1);
    assert.equal(reloaded.cursor, 5);
    assert.deepEqual(reloaded.messages, [summaryMessage]);
    assert.equal(reloaded.window.currentWindowId, full.window.currentWindowId);

    const journal = await readFile(join(run.runDir, "dialogue", "dev-attempt-1.ndjson"), "utf8");
    assert.match(journal, /original one/);
    assert.match(journal, /"journal_type":"compacted"/);
    assert.match(journal, /"replacement_history"/);
    assert.equal(journal.trim().split("\n").length, 5);
  });

  it("replays a recovery reconciliation without rewriting prior dialogue records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-dialogue-reconcile-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "x" });
    const call = { id: "submit-1", name: "SubmitNodeResult", input: { direction: "forward" } };
    const original: ModelMessage[] = [
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "user", content: "continue" }
    ];
    assert.equal(await store.syncWorkflowDialogue(run.runId, "dev", 1, original), 2);
    const recovered: ModelMessage = { role: "tool", tool_call_id: "submit-1", content: "{\"status\":\"submitted\"}" };
    const reconciled = [original[0]!, recovered, original[1]!];

    const state = await store.reconcileWorkflowDialogue(run.runId, "dev", 1, reconciled, [recovered]);

    assert.equal(state.cursor, 3);
    assert.deepEqual(state.messages, reconciled);
    assert.equal(state.window.windowNumber, 0);
    const reloaded = await new RunStore(root).loadWorkflowDialogueState(run.runId, "dev", 1);
    assert.equal(reloaded.cursor, 3);
    assert.deepEqual(reloaded.messages, reconciled);
    assert.equal(reloaded.window.windowNumber, 0);
    const journal = await readFile(join(run.runDir, "dialogue", "dev-attempt-1.ndjson"), "utf8");
    assert.match(journal, /"role":"user","content":"continue"/);
    assert.match(journal, /"journal_type":"reconcile"/);
    assert.equal(journal.trim().split("\n").length, 3);
  });

  it("recovers durable journal tail records written after the last checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-dialogue-tail-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "x" });
    const first: ModelMessage[] = [{ role: "user", content: "before checkpoint" }];
    assert.equal(await store.syncWorkflowDialogue(run.runId, "dev", 1, first), 1);
    await store.saveState(run.runId, workflowState({
      status: "paused",
      workflow_id: "delivery",
      current_node_id: "dev",
      resume_checkpoint: {
        node_id: "dev",
        handoff: {},
        attempt: 1,
        activation: 1,
        dialogue_cursor: 1,
        dialogue_messages: first
      }
    }));
    const durableTail: ModelMessage[] = [...first, { role: "assistant", content: "written before crash" }];
    assert.equal(await store.syncWorkflowDialogue(run.runId, "dev", 1, durableTail), 2);

    const recovered = await new RunStore(root).loadState(run.runId);

    assert.equal(recovered.resume_checkpoint?.dialogue_cursor, 2);
    assert.deepEqual(recovered.resume_checkpoint?.dialogue_messages, durableTail);
  });

  it("prevents a second store from acquiring the same active run lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-run-lease-"));
    const firstStore = new RunStore(root);
    const run = await firstStore.createRun("delivery", { request: "x" });
    const lease = await firstStore.acquireRunLease(run.runId);

    await assert.rejects(() => new RunStore(root).acquireRunLease(run.runId), /already active/);
    await lease.release();
    const nextLease = await new RunStore(root).acquireRunLease(run.runId);
    await nextLease.release();
  });

});

function workflowState(input: Pick<WorkflowState, "status" | "workflow_id"> & Partial<WorkflowState>): WorkflowState {
  return {
    version: 2,
    attempts: [],
    node_checkpoints: {},
    suspended_stack: [],
    rework_count: 0,
    rework_limit: 10,
    ...input
  };
}

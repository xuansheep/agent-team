import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../../src/storage/runStore.js";

describe("RunStore", () => {
  it("uses .session as the default storage root", () => {
    const store = new RunStore();

    assert.equal(store.runDir("session-1"), join(".session", "session-1"));
  });

  it("creates a run directory and appends ndjson events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runs-"));
    const store = new RunStore(root);
    const run = await store.createRun("delivery", { request: "build it" });

    await store.appendEvent(run.runId, { type: "node_started", node_id: "product", attempt: 1 });
    await store.saveState(run.runId, { status: "running", workflow_id: "delivery", current_node_id: "product", attempts: [] });

    const events = await readFile(join(run.runDir, "events.ndjson"), "utf8");
    assert.match(events, /run_started/);
    assert.match(events, /node_started/);

    const state = JSON.parse(await readFile(join(run.runDir, "state.json"), "utf8"));
    assert.equal(state.current_node_id, "product");
  });

  it("lists run summaries newest first and skips unreadable runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-list-runs-"));
    const store = new RunStore(root);

    const first = await store.createRun("delivery", { request: "first workflow request" });
    await store.saveState(first.runId, { status: "completed", workflow_id: "delivery", attempts: [] });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.createRun("audit", { request: "second workflow request with a long body" });
    await store.saveState(second.runId, { status: "pending", workflow_id: "audit", current_node_id: "product", attempts: [] });

    await mkdir(join(root, "broken-run"));
    await writeFile(join(root, "broken-run", "state.json"), "not-json", "utf8");

    const runs = await store.listRuns();

    assert.equal(runs[0]?.runId, second.runId);
    assert.equal(runs[0]?.workflowId, "audit");
    assert.equal(runs[0]?.status, "pending");
    assert.equal(runs[0]?.currentNodeId, "product");
    assert.match(runs[0]?.inputPreview ?? "", /second workflow request/);
    assert.deepEqual(runs.map((run) => run.runId), [second.runId, first.runId]);
  });

  it("returns an empty run list when the run root does not exist", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "agent-team-empty-runs-")), "missing");
    const store = new RunStore(root);

    assert.deepEqual(await store.listRuns(), []);
  });

});

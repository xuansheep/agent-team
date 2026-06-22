import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../../src/storage/runStore.js";

describe("RunStore", () => {
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
});

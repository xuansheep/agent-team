import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/storage/runStore.js";

describe("interactive run events", () => {
  it("stores permission and interrupt events", async () => {
    const store = new RunStore(".tmp/interactive-events");
    const run = await store.createRun("flow", { request: "x" });

    await store.appendEvent(run.runId, {
      type: "permission_requested",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "Bash",
      input: { command: "npm test" },
      specifier: "npm test"
    });
    await store.appendEvent(run.runId, {
      type: "permission_resolved",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      decision: "allow_once"
    });
    await store.markInterrupted(run.runId, {
      status: "interrupted",
      workflow_id: "flow",
      current_node_id: "dev",
      attempts: [{ node_id: "dev", attempt: 1, status: "running" }],
      handoff: { request: "x" }
    });

    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) => event.type === "permission_requested"), true);
    assert.equal(events.some((event) => event.type === "permission_resolved"), true);
    assert.equal(events.some((event) => event.type === "run_interrupted"), true);

    const state = await store.loadState(run.runId);
    assert.equal(state.status, "interrupted");
    assert.equal(state.current_node_id, "dev");
  });
});

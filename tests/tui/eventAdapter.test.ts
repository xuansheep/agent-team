import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialTuiState, reduceStoredEvent } from "../../src/tui/eventAdapter.js";

describe("TUI event adapter", () => {
  it("groups node attempts and tool calls by runtime events", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "dev", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, {
      type: "tool_invoked",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "Bash",
      input: { command: "npm test" },
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });
    state = reduceStoredEvent(state, {
      type: "tool_completed",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "Bash",
      result: { output: "ok" },
      ts: "2026-06-23T00:00:02.000Z",
      seq: 3
    });

    assert.equal(state.currentNodeId, "dev");
    assert.equal(state.nodes[0]?.status, "running");
    assert.equal(state.tools[0]?.status, "completed");
  });

  it("tracks pending permission requests", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, {
      type: "permission_requested",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "Bash",
      input: {},
      specifier: "npm test",
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    });
    assert.equal(state.permissionRequests.length, 1);

    state = reduceStoredEvent(state, {
      type: "permission_resolved",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      decision: "deny_once",
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });
    assert.equal(state.permissionRequests.length, 0);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialTuiState, reduceStoredEvent, resetTuiRunState } from "../../src/tui/eventAdapter.js";

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

  it("tracks streaming model output by node attempt", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, {
      type: "model_stream_delta",
      node_id: "product",
      attempt: 1,
      text: "{\"status\":",
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    });
    state = reduceStoredEvent(state, {
      type: "model_stream_delta",
      node_id: "product",
      attempt: 1,
      text: "\"success\"}",
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });

    assert.deepEqual(state.modelStreams, [{ nodeId: "product", attempt: 1, text: "{\"status\":\"success\"}" }]);
  });

  it("records the initial user request and resumed user answers in conversation", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, {
      type: "run_started",
      workflow_id: "delivery",
      input: { request: "实现 TUI 布局" },
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    });
    state = reduceStoredEvent(state, {
      type: "user_message",
      text: "验收通过",
      node_id: "user_acceptance",
      attempt: 1,
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });

    assert.deepEqual(state.conversation.filter((item) => item.kind === "user").map((item) => item.text), ["实现 TUI 布局", "验收通过"]);
  });

  it("shows readable node progress and result summaries without raw JSON", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "product", attempt: 1, text: "{\"status\":", ts: "2026-06-23T00:00:01.000Z", seq: 2 });
    state = reduceStoredEvent(state, {
      type: "node_completed",
      node_id: "product",
      status: "success",
      result: {
        status: "success",
        summary: "已梳理项目架构",
        deliverables: ["架构概览"],
        handoff: { instruction: "交给 dev 继续实现" }
      },
      ts: "2026-06-23T00:00:03.000Z",
      seq: 4
    });

    assert.deepEqual(state.conversation.map((item) => ({ kind: item.kind, nodeId: item.nodeId, attempt: item.attempt, text: item.text })), [
      { kind: "status", nodeId: "product", attempt: 1, text: "product 正在处理..." },
      { kind: "status", nodeId: "product", attempt: 1, text: "product 正在生成响应..." },
      { kind: "status", nodeId: "product", attempt: 1, text: "product 已完成：已梳理项目架构" }
    ]);
    assert.match(state.conversation.at(-1)?.detailText ?? "", /产出：架构概览/);
    assert.match(state.conversation.at(-1)?.detailText ?? "", /交接：交给 dev 继续实现/);
    assert.doesNotMatch(state.conversation.map((item) => `${item.text}\n${item.detailText ?? ""}`).join("\n"), /\{"status"/);
  });


  it("keeps the plan document visible and switches to revision input after pausing", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, {
      type: "plan_review_requested",
      node_id: "product",
      attempt: 1,
      document: "# Plan\n\n旧计划",
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });
    state = reduceStoredEvent(state, {
      type: "plan_review_resolved",
      node_id: "product",
      attempt: 1,
      decision: "stay",
      ts: "2026-06-23T00:00:02.000Z",
      seq: 3
    });

    assert.equal(state.mode, "plan_revision");
    assert.match(state.pendingReview?.document ?? "", /旧计划/);

    state = reduceStoredEvent(state, {
      type: "plan_review_requested",
      node_id: "product",
      attempt: 2,
      document: "# Plan\n\n新计划",
      ts: "2026-06-23T00:00:03.000Z",
      seq: 4
    });

    assert.equal(state.mode, "waiting_plan_review");
    assert.equal(state.pendingReview?.attempt, 2);
    assert.match(state.pendingReview?.document ?? "", /新计划/);
  });

  it("tracks plan review documents and clears them after approval", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, {
      type: "plan_review_requested",
      node_id: "product",
      attempt: 1,
      document: "# Plan\n\n执行步骤",
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });

    assert.equal(state.mode, "waiting_plan_review");
    assert.equal(state.pendingReview?.type, "plan");
    assert.match(state.pendingReview?.document ?? "", /执行步骤/);
    assert.equal(state.nodes[0]?.status, "waiting_plan_review");

    state = reduceStoredEvent(state, {
      type: "plan_review_resolved",
      node_id: "product",
      attempt: 1,
      decision: "continue",
      ts: "2026-06-23T00:00:02.000Z",
      seq: 3
    });

    assert.equal(state.mode, "running");
    assert.equal(state.pendingReview, undefined);
  });

  it("records run failure details for detailed logs", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, {
      type: "run_failed",
      error: "Provider network request failed after 3 attempts: fetch failed",
      detail: "endpoint: https://api.example.test/v1/chat/completions\nattempts: 3\ncause.code: ECONNRESET",
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    } as any);

    assert.equal(state.error, "Provider network request failed after 3 attempts: fetch failed");
    assert.match(state.conversation.at(-1)?.detailText ?? "", /cause.code: ECONNRESET/);
  });

  it("resets stale run state when a new interactive run starts", () => {
    const state = {
      ...initialTuiState({ cwd: "D:\\CodeAI\\agent-team" }),
      mode: "failed" as const,
      workflowId: "delivery",
      runId: "old-run",
      currentNodeId: "product",
      nodes: [{ nodeId: "product", attempt: 1, status: "success" as const }],
      tools: [{ nodeId: "product", attempt: 1, toolCallId: "tool-1", tool: "Bash", status: "failed" as const, expanded: false }],
      permissionRequests: [{ requestId: "perm-1", nodeId: "product", attempt: 1, toolCallId: "tool-1", tool: "Bash", input: {}, specifier: "npm test" }],
      modelStreams: [{ nodeId: "product", attempt: 1, text: "old" }],
      conversation: [{ kind: "status" as const, text: "old log" }],
      questions: [{ id: "q1" }],
      timeline: ["old"],
      error: "old error"
    };

    const reset = resetTuiRunState(state, { workflowId: "delivery", runId: "new-run" });

    assert.equal(reset.cwd, state.cwd);
    assert.equal(reset.workflowId, "delivery");
    assert.equal(reset.runId, "new-run");
    assert.equal(reset.mode, "running");
    assert.equal(reset.currentNodeId, undefined);
    assert.deepEqual(reset.nodes, []);
    assert.deepEqual(reset.tools, []);
    assert.deepEqual(reset.permissionRequests, []);
    assert.deepEqual(reset.modelStreams, []);
    assert.deepEqual(reset.conversation, []);
    assert.deepEqual(reset.questions, []);
    assert.deepEqual(reset.timeline, []);
    assert.equal(reset.error, undefined);
  });


  it("shows parsed tool completion details without raw JSON", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, {
      type: "tool_invoked",
      node_id: "product",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "LS",
      input: { path: "." },
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });
    state = reduceStoredEvent(state, {
      type: "tool_completed",
      node_id: "product",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "LS",
      result: { output: "package.json\nsrc", exit_code: 0 },
      ts: "2026-06-23T00:00:02.000Z",
      seq: 3
    });

    assert.equal(state.tools[0]?.status, "completed");
    assert.equal(state.conversation.at(-2)?.text, "正在执行 LS...");
    assert.equal(state.conversation.at(-1)?.text, "LS 执行完成");
    assert.match(state.conversation.at(-1)?.detailText ?? "", /输出：package.json/);
    assert.doesNotMatch(state.conversation.at(-1)?.detailText ?? "", /\{"output"/);
  });

  it("records compact and detailed tool and permission log entries", () => {
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
      type: "permission_requested",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "Bash",
      input: { command: "npm test" },
      specifier: "npm test",
      ts: "2026-06-23T00:00:02.000Z",
      seq: 3
    });

    const toolLog = state.conversation.find((item) => item.text.includes("正在执行 Bash"));
    const permissionLog = state.conversation.find((item) => item.text.includes("需要确认是否允许 Bash"));
    assert.match(toolLog?.detailText ?? "", /命令：npm test/);
    assert.match(permissionLog?.detailText ?? "", /目标：npm test/);
    assert.doesNotMatch(`${toolLog?.detailText ?? ""}
${permissionLog?.detailText ?? ""}`, /\{"command"/);
  });
});

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
    assert.equal(state.logMessages.filter((item) => item.kind === "tool").length, 1);
    const toolLog = state.logMessages.find((item) => item.kind === "tool");
    assert.equal(toolLog?.status, "completed");
    assert.equal(toolLog?.summary, "npm test");
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
    const requestedLog = state.logMessages.find((item) => item.kind === "permission");
    assert.equal(requestedLog?.status, "pending");
    assert.match(requestedLog?.text ?? "", /需要确认/);

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
    const resolvedLog = state.logMessages.find((item) => item.kind === "permission");
    assert.equal(resolvedLog?.status, "denied");
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
    assert.match(state.logMessages.at(-1)?.text ?? "", /正在生成响应/);
  });

  it("tracks streaming thinking separately from response output", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, {
      type: "model_thinking_delta",
      node_id: "product",
      attempt: 1,
      text: "Checked constraints.",
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    } as any);

    assert.deepEqual(state.modelStreams, []);
    assert.match(state.logMessages.at(-1)?.text ?? "", /product 正在思考/);
    assert.match(state.logMessages.at(-1)?.detailText ?? "", /Checked constraints/);
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
    assert.deepEqual(state.logMessages.filter((item) => item.kind === "user").map((item) => item.text), ["实现 TUI 布局", "验收通过"]);
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
    // Model stream content is now intentionally shown in the streaming status detailText
    const streamLog = state.logMessages.find((item) => item.text.includes("正在生成响应"));
    assert.match(streamLog?.detailText ?? "", /模型输出：/);
    // Non-stream log messages should not contain raw JSON
    const nonStreamLogs = state.logMessages.filter((item) => !item.text.includes("正在生成响应") && !item.text.includes("正在思考"));
    assert.doesNotMatch(nonStreamLogs.map((item) => `${item.text}\n${item.detailText ?? ""}`).join("\n"), /\{"status"/);
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

  it("keeps a failed node marked failed when waiting for user input", () => {
    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "dev", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, {
      type: "node_completed",
      node_id: "dev",
      status: "failure",
      result: { status: "failure", summary: "Provider request failed 400", feedback: { defects: ["bad request"], change_requests: [] } },
      ts: "2026-06-23T00:00:01.000Z",
      seq: 2
    });
    state = reduceStoredEvent(state, {
      type: "node_waiting_user",
      node_id: "dev",
      questions: [{ id: "next_step", text: "如何继续？", required: true }],
      ts: "2026-06-23T00:00:02.000Z",
      seq: 3
    });

    assert.equal(state.mode, "question");
    assert.equal(state.nodes[0]?.status, "failure");
    assert.deepEqual(state.questions, [{ id: "next_step", text: "如何继续？", required: true }]);
    assert.match(state.logMessages.at(-1)?.text ?? "", /dev 需要用户补充信息：如何继续？/);
    assert.match(state.conversation.at(-1)?.detailText ?? "", /问题：如何继续？/);
    assert.doesNotMatch(state.conversation.at(-1)?.detailText ?? "", /\{.*next_step/);
    assert.doesNotMatch(state.logMessages.at(-1)?.detailText ?? "", /\{.*next_step/);

    state = reduceStoredEvent(state, {
      type: "user_message",
      text: "请重试",
      node_id: "dev",
      attempt: 1,
      ts: "2026-06-23T00:00:03.000Z",
      seq: 4
    });

    assert.deepEqual(state.questions, []);
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
    assert.equal(state.nodes[0]?.status, "waiting_user");

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

  it("logs workflow transitions as visible timeline entries", () => {
    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });
    state = reduceStoredEvent(state, {
      type: "transition",
      from: "product",
      to: "dev",
      reason: "success",
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    });

    assert.match(state.conversation.at(-1)?.text ?? "", /流程流转：product -> dev（success）/);
    assert.match(state.logMessages.at(-1)?.text ?? "", /流程流转：product -> dev（success）/);
  });

  it("shows artifact creation events with artifact path", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, {
      type: "artifact_created",
      node_id: "final_delivery",
      artifact_id: "final_delivery/final-summary.md",
      path: ".tmp/final-runs/run-1/artifacts/final_delivery/final-summary.md",
      ts: "2026-06-23T00:00:00.000Z",
      seq: 1
    });

    assert.match(state.conversation.at(-1)?.text ?? "", /final_delivery 已保存产出/);
    assert.match(state.conversation.at(-1)?.detailText ?? "", /final_delivery\/final-summary\.md/);
    assert.match(state.logMessages.at(-1)?.detailText ?? "", /artifacts\/final_delivery\/final-summary\.md/);
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
      logMessages: [{ id: "old", kind: "status" as const, text: "old log" }],
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
    assert.deepEqual(reset.logMessages, []);
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
    // Tool status logs are now only in logMessages (kind: "tool"), not in conversation
    // After completion, the tool log status is updated to "completed"
    const toolLog = state.logMessages.find((item) => item.kind === "tool");
    assert.equal(toolLog?.text, "List");
    assert.equal((toolLog as any)?.summary, ".");
    assert.equal((toolLog as any)?.status, "completed");
    assert.match((toolLog as any)?.detailText ?? "", /输出：package.json/);
    assert.doesNotMatch((toolLog as any)?.detailText ?? "", /\{"output"/);
    const toolLogs = state.logMessages.filter((item) => item.kind === "tool");
    assert.equal(toolLogs.length, 1);
    assert.equal((toolLogs[0] as any)?.status, "completed");
    assert.equal((toolLogs[0] as any)?.summary, ".");
    assert.match((toolLogs[0] as any)?.detailText ?? "", /输出：package.json/);
    assert.doesNotMatch((toolLogs[0] as any)?.detailText ?? "", /\{"output"/);
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

    // Tool status logs are now only in logMessages (kind: "tool"), not in conversation
    const semanticToolLog = state.logMessages.find((item) => item.kind === "tool");
    assert.match(semanticToolLog?.detailText ?? "", /命令：npm test/);
    assert.equal((semanticToolLog as any)?.summary, "npm test");
    const permissionLog = state.conversation.find((item) => item.text.includes("需要确认是否允许 Bash"));
    assert.match(permissionLog?.detailText ?? "", /目标：npm test/);
    const semanticPermissionLog = state.logMessages.find((item) => item.kind === "permission");
    assert.match(semanticPermissionLog?.text ?? "", /需要确认/);
    assert.doesNotMatch(`${semanticToolLog?.detailText ?? ""}
${semanticPermissionLog?.detailText ?? ""}`, /\{"command"/);
  });
});

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

    assert.equal(state.conversation.some((item) => item.text.includes("需要确认是否允许")), false);

    assert.equal(state.logMessages.filter((item) => item.text.includes("需要确认是否允许")).length, 1);



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

    assert.equal(state.conversation.some((item) => item.text === "已拒绝本次操作"), false);

    assert.equal(state.logMessages.filter((item) => item.text === "已拒绝本次操作").length, 1);

  });



  it("keeps internal NodeResult streams out of visible assistant logs", () => {

    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });

    state = reduceStoredEvent(state, {

      type: "model_stream_delta",

      node_id: "product",

      attempt: 1,

      text: "{\"direction\":",

      ts: "2026-06-23T00:00:00.000Z",

      seq: 1

    });

    state = reduceStoredEvent(state, {

      type: "model_stream_delta",

      node_id: "product",

      attempt: 1,

      text: "\"forward\"}",

      ts: "2026-06-23T00:00:01.000Z",

      seq: 2

    });



    assert.deepEqual(state.modelStreams, [{ nodeId: "product", attempt: 1, activation: 1, text: "{\"direction\":\"forward\"}" }]);

    assert.equal(state.logMessages.some((item) => item.kind === "assistant"), false);

    assert.equal(state.logMessages.some((item) => item.text.includes("正在生成响应")), false);

  });



  it("renders natural language model stream deltas as one assistant preamble", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, {

      type: "model_stream_delta",

      node_id: "product",

      attempt: 1,

      text: "我先检查工作流事件，",

      ts: "2026-06-23T00:00:00.000Z",

      seq: 1

    });

    state = reduceStoredEvent(state, {

      type: "model_stream_delta",

      node_id: "product",

      attempt: 1,

      text: "再确认 TUI 渲染入口。",

      ts: "2026-06-23T00:00:01.000Z",

      seq: 2

    });



    const assistantLogs = state.logMessages.filter((item) => item.kind === "assistant");

    assert.equal(assistantLogs.length, 1);

    assert.equal(assistantLogs[0]?.text, "我先检查工作流事件，再确认 TUI 渲染入口。");

    assert.equal(state.conversation.filter((item) => item.kind === "assistant").length, 1);

    assert.equal(state.logMessages.some((item) => item.text.includes("正在生成响应")), false);

  });



  it("hides final NodeResult JSON after a visible assistant preamble", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "product", attempt: 1, text: "我先确认上下文。\n", ts: "2026-06-23T00:00:00.000Z", seq: 1 });

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "product", attempt: 1, text: "{\"direction\":\"forward\",\"summary\":\"done\"}", ts: "2026-06-23T00:00:01.000Z", seq: 2 });



    const assistantLogs = state.logMessages.filter((item) => item.kind === "assistant");

    assert.equal(assistantLogs.length, 1);

    assert.equal(assistantLogs[0]?.text, "我先确认上下文。");

    assert.equal(assistantLogs[0]?.text.includes("status"), false);

  });



  it("does not use partial NodeResult JSON or fallback text as the tool parent preamble", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, {

      type: "model_stream_delta",

      node_id: "product",

      attempt: 1,

      text: `{"deliverables":[],"document":"","feedback":{"change_requests":[],"defects":[]},"handoff":{"instruction":"","known_risks":[],"must_follow":[],"open_questions":[]},"questions":[],"status`,

      ts: "2026-06-23T00:00:00.000Z",

      seq: 1

    });

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



    const assistantLogs = state.logMessages.filter((item) => item.kind === "assistant");

    assert.equal(assistantLogs.length, 0);

    assert.doesNotMatch(state.logMessages.map((item) => item.text).join("\n"), /deliverables|status|准备使用/);

    const toolLog = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-1");

    assert.equal(toolLog?.parentLogId, undefined);

  });



  it("does not render short partial NodeResult key prefixes as assistant preambles", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "product", attempt: 1, text: "{\"deliver", ts: "2026-06-23T00:00:00.000Z", seq: 1 });

    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "product", attempt: 1, tool_call_id: "tool-short", tool: "LS", input: { path: "." }, ts: "2026-06-23T00:00:01.000Z", seq: 2 });



    const assistantLogs = state.logMessages.filter((item) => item.kind === "assistant");

    assert.equal(assistantLogs.length, 0);

    assert.doesNotMatch(state.logMessages.map((item) => item.text).join("\n"), /\{"deliver|准备使用/);

    const toolLog = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-short");

    assert.equal(toolLog?.parentLogId, undefined);

  });



  it("renders streaming thinking as one visible reasoning log", () => {

    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });

    state = reduceStoredEvent(state, {

      type: "model_thinking_delta",

      node_id: "product",

      attempt: 1,

      text: "先检查约束，",

      ts: "2026-06-23T00:00:00.000Z",

      seq: 1

    } as any);

    state = reduceStoredEvent(state, {

      type: "model_thinking_delta",

      node_id: "product",

      attempt: 1,

      text: "再定位渲染入口。",

      ts: "2026-06-23T00:00:01.000Z",

      seq: 2

    } as any);



    assert.deepEqual(state.modelStreams, []);

    assert.deepEqual(state.conversation, []);

    const thinkingLogs = state.logMessages.filter((item) => item.kind === "status" && item.nodeId === "product" && item.attempt === 1);

    assert.equal(thinkingLogs.length, 1);

    assert.equal(thinkingLogs[0]?.text, "Reasoning");

    assert.equal(thinkingLogs[0]?.detailText, "先检查约束，再定位渲染入口。");

    assert.deepEqual(state.timeline, ["model_thinking_delta", "model_thinking_delta"]);

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

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "product", attempt: 1, text: "{\"direction\":", ts: "2026-06-23T00:00:01.000Z", seq: 2 });

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

      { kind: "status", nodeId: "product", attempt: 1, text: "product 已完成：已梳理项目架构" }

    ]);

    assert.match(state.conversation.at(-1)?.detailText ?? "", /产出：架构概览/);

    assert.match(state.conversation.at(-1)?.detailText ?? "", /交接：交给 dev 继续实现/);

    assert.equal(state.logMessages.some((item) => item.text.includes("正在生成响应")), false);

    assert.doesNotMatch(state.logMessages.map((item) => `${item.text}\n${item.detailText ?? ""}`).join("\n"), /\{"status"/);

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

  it("preserves logs when resetting into a workflow from Plan Mode", () => {
    const state = {
      ...initialTuiState({ cwd: "D:\\CodeAI\\agent-team" }),
      mode: "waiting_plan_approval" as const,
      inputPermissionMode: "plan" as const,
      workflowId: "delivery",
      conversation: [{ kind: "status" as const, text: "Plan approval requested" }],
      logMessages: [{ id: "plan", kind: "plan" as const, nodeId: "global-plan", attempt: 1, status: "pending" as const, text: "Plan Review", document: "Do the work." }],
      nodes: [{ nodeId: "global-plan", attempt: 1, status: "success" as const }],
      tools: [{ nodeId: "global-plan", attempt: 1, toolCallId: "tool-1", tool: "Write", status: "completed" as const, expanded: false }],
      questions: [{ id: "q1" }],
      timeline: ["plan"]
    };

    const reset = resetTuiRunState(state, { workflowId: "delivery", runId: "workflow-run", preserveLogs: true, inputPermissionMode: "default" });

    assert.equal(reset.runId, "workflow-run");
    assert.equal(reset.mode, "running");
    assert.equal(reset.inputPermissionMode, "default");
    assert.deepEqual(reset.nodes, []);
    assert.deepEqual(reset.tools, []);
    assert.deepEqual(reset.questions, []);
    assert.deepEqual(reset.timeline, []);
    assert.deepEqual(reset.conversation, state.conversation);
    assert.deepEqual(reset.logMessages, state.logMessages);
  });





  it("attaches tool logs only under real assistant preambles", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, { type: "node_started", node_id: "dev", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });

    assert.equal(state.logMessages.some((item) => item.text.includes("正在处理")), false);



    state = reduceStoredEvent(state, {

      type: "model_stream_delta",

      node_id: "dev",

      attempt: 1,

      text: "我先运行测试确认现状。",

      ts: "2026-06-23T00:00:01.000Z",

      seq: 2

    });

    state = reduceStoredEvent(state, {

      type: "tool_invoked",

      node_id: "dev",

      attempt: 1,

      tool_call_id: "tool-1",

      tool: "Bash",

      input: { command: "npm test" },

      ts: "2026-06-23T00:00:02.000Z",

      seq: 3

    });



    const assistantLog = state.logMessages.find((item) => item.kind === "assistant");

    const toolLog = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-1");

    assert.equal(assistantLog?.text, "我先运行测试确认现状。");

    assert.equal(toolLog?.parentLogId, assistantLog?.id);



    state = reduceStoredEvent(state, {

      type: "tool_invoked",

      node_id: "test",

      attempt: 1,

      tool_call_id: "tool-2",

      tool: "Bash",

      input: { command: "npm run lint" },

      ts: "2026-06-23T00:00:03.000Z",

      seq: 4

    });

    const fallback = state.logMessages.find((item) => item.kind === "assistant" && item.nodeId === "test");

    const fallbackTool = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-2");

    assert.equal(fallback, undefined);

    assert.equal(fallbackTool?.parentLogId, undefined);

  });





  it("keeps later assistant preambles as separate tool parents", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, { type: "node_started", node_id: "dev", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "dev", attempt: 1, text: "我先列目录。", ts: "2026-06-23T00:00:01.000Z", seq: 2 });

    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "LS", input: { path: "." }, ts: "2026-06-23T00:00:02.000Z", seq: 3 });

    state = reduceStoredEvent(state, { type: "tool_completed", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "LS", result: { output: "package.json" }, ts: "2026-06-23T00:00:03.000Z", seq: 4 });

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "dev", attempt: 1, text: "再读取 package。", ts: "2026-06-23T00:00:04.000Z", seq: 5 });

    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "dev", attempt: 1, tool_call_id: "tool-2", tool: "Read", input: { file_path: "package.json" }, ts: "2026-06-23T00:00:05.000Z", seq: 6 });



    const assistantLogs = state.logMessages.filter((item) => item.kind === "assistant");

    const firstTool = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-1");

    const secondTool = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-2");



    assert.deepEqual(assistantLogs.map((item) => item.text), ["我先列目录。", "再读取 package。"]);

    assert.equal(firstTool?.parentLogId, assistantLogs[0]?.id);

    assert.equal(secondTool?.parentLogId, assistantLogs[1]?.id);

  });



  it("does not attach later tools to a stale assistant preamble after a status boundary", () => {

    let state = initialTuiState({ cwd: "D:\CodeAI\agent-team" });

    state = reduceStoredEvent(state, { type: "node_started", node_id: "dev", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });

    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "dev", attempt: 1, text: "我先列目录。", ts: "2026-06-23T00:00:01.000Z", seq: 2 });

    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "LS", input: { path: "." }, ts: "2026-06-23T00:00:02.000Z", seq: 3 });

    state = reduceStoredEvent(state, { type: "tool_completed", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "LS", result: { output: "package.json" }, ts: "2026-06-23T00:00:03.000Z", seq: 4 });

    state = reduceStoredEvent(state, { type: "artifact_created", node_id: "dev", artifact_id: "dev/report.md", path: ".session/run/artifacts/dev/report.md", ts: "2026-06-23T00:00:04.000Z", seq: 5 });

    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "dev", attempt: 1, tool_call_id: "tool-2", tool: "Bash", input: { command: "npm test" }, ts: "2026-06-23T00:00:05.000Z", seq: 6 });



    const assistantLog = state.logMessages.find((item) => item.kind === "assistant");

    const firstTool = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-1");

    const secondTool = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-2");



    assert.equal(firstTool?.parentLogId, assistantLog?.id);

    assert.equal(secondTool?.parentLogId, undefined);

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

      result: { output: "package.json\nsrc\nmiddle-file\nanother-file\nfixture-a\nfixture-b\nlast-file", exit_code: 0 },

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
    assert.match((toolLog as any)?.detailText ?? "", /middle-file/);
    assert.match((toolLog as any)?.compactDetailText ?? "", /输出：package.json/);
    assert.match((toolLog as any)?.compactDetailText ?? "", /ctrl \+ o to view transcript/);
    assert.doesNotMatch((toolLog as any)?.compactDetailText ?? "", /middle-file/);

    assert.doesNotMatch((toolLog as any)?.detailText ?? "", /\{"output"/);

    const toolLogs = state.logMessages.filter((item) => item.kind === "tool");

    assert.equal(toolLogs.length, 1);

    assert.equal((toolLogs[0] as any)?.status, "completed");

    assert.equal((toolLogs[0] as any)?.summary, ".");

    assert.match((toolLogs[0] as any)?.detailText ?? "", /输出：package.json/);
    assert.match((toolLogs[0] as any)?.detailText ?? "", /middle-file/);
    assert.match((toolLogs[0] as any)?.compactDetailText ?? "", /输出：package.json/);
    assert.match((toolLogs[0] as any)?.compactDetailText ?? "", /ctrl \+ o to view transcript/);
    assert.doesNotMatch((toolLogs[0] as any)?.compactDetailText ?? "", /middle-file/);

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

    assert.equal(state.conversation.some((item) => item.text.includes("需要确认是否允许 Bash")), false);

    const semanticPermissionLog = state.logMessages.find((item) => item.kind === "permission");

    assert.match(semanticPermissionLog?.text ?? "", /需要确认/);

    assert.match(semanticPermissionLog?.detailText ?? "", /目标：npm test/);

    assert.doesNotMatch(`${semanticToolLog?.detailText ?? ""}

${semanticPermissionLog?.detailText ?? ""}`, /\{"command"/);

  });

  it("hides NodeResult JSON fragments that precede tool calls in the visible transcript", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "product", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, { type: "model_stream_delta", node_id: "product", attempt: 1, text: "{\"deliver", ts: "2026-06-23T00:00:01.000Z", seq: 2 });
    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "product", attempt: 1, tool_call_id: "tool-1", tool: "LS", input: { path: "." }, ts: "2026-06-23T00:00:02.000Z", seq: 3 });
    state = reduceStoredEvent(state, { type: "tool_completed", node_id: "product", attempt: 1, tool_call_id: "tool-1", tool: "LS", result: { output: ".git/\npackage.json", exit_code: 0 }, ts: "2026-06-23T00:00:03.000Z", seq: 4 });

    const visibleText = state.logMessages.map((item) => `${item.text}\n${item.detailText ?? ""}`).join("\n");
    assert.doesNotMatch(visibleText, /deliverables|\{\"deliver|status|feedback|handoff/);
    assert.equal(state.logMessages.some((item) => item.kind === "assistant"), false);
    const toolLog = state.logMessages.find((item) => item.kind === "tool" && item.toolCallId === "tool-1");
    assert.equal(toolLog?.parentLogId, undefined);
    assert.match(toolLog?.detailText ?? "", /输出：\.git/);
  });

});

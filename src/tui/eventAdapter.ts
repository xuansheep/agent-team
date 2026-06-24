import { StoredEvent } from "../harness/events.js";
import { TuiLogMessage, TuiToolLogMessage } from "./logTypes.js";
import { TuiConversationItem, TuiModelStreamState, TuiNodeState, TuiState } from "./state.js";
import { getToolDisplayName, getToolInputDetail, getToolInputSummary, getToolResultDetail, readableRecord, readableValue, truncate } from "./toolDisplay.js";

export function initialTuiState(input: { cwd: string }): TuiState {
  return {
    cwd: input.cwd,
    mode: "boot",
    nodes: [],
    tools: [],
    permissionRequests: [],
    modelStreams: [],
    conversation: [],
    logMessages: [],
    questions: [],
    timeline: [],
    resumeRuns: []
  };
}

export function resetTuiRunState(state: TuiState, input: { workflowId: string; runId: string }): TuiState {
  return {
    ...initialTuiState({ cwd: state.cwd }),
    workflowId: input.workflowId,
    runId: input.runId,
    mode: "running"
  };
}

export function reduceStoredEvent(state: TuiState, event: StoredEvent): TuiState {
  const next: TuiState = { ...state, timeline: [...state.timeline, event.type] };

  switch (event.type) {
    case "run_started":
      return appendConversation({ ...next, workflowId: event.workflow_id, mode: "running" }, { kind: "user", text: inputText(event.input) }, event);
    case "user_message":
      return appendConversation(next, { kind: "user", nodeId: event.node_id, attempt: event.attempt, text: event.text }, event);
    case "node_started":
      return appendConversation(
        upsertNode({ ...next, mode: "running", currentNodeId: event.node_id }, event.node_id, event.attempt, "running"),
        { kind: "status", nodeId: event.node_id, attempt: event.attempt, text: `${event.node_id} 正在处理...`, detailText: `节点：${event.node_id}\n第 ${event.attempt} 次尝试` },
        event
      );
    case "plan_review_requested":
      return appendConversation(
        upsertNode({
          ...next,
          mode: "waiting_plan_review",
          currentNodeId: event.node_id,
          pendingReview: { type: "plan", nodeId: event.node_id, attempt: event.attempt, document: event.document }
        }, event.node_id, event.attempt, "waiting_plan_review"),
        { kind: "status", nodeId: event.node_id, attempt: event.attempt, text: `${event.node_id} 已生成计划，等待用户审核`, detailText: event.document },
        event
      );
    case "plan_review_resolved":
      if (event.decision === "stay") {
        return appendConversation({ ...next, mode: "plan_revision" }, { kind: "status", nodeId: event.node_id, attempt: event.attempt, text: "计划审核保持暂停，可继续输入修改意见", detailText: "用户选择：No, staying in the plan" }, event);
      }
      return appendConversation({ ...next, mode: "running", pendingReview: undefined }, {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        text: "计划已通过，继续执行",
        detailText: "用户选择：Yes, continue execution by plan"
      }, event);
    case "complete_summary_available":
      return appendConversation(next, {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        text: `${event.node_id} 已生成流程总结`,
        detailText: event.document
      }, event);
    case "artifact_created":
      return appendConversation(next, {
        kind: "status",
        nodeId: event.node_id,
        text: `${event.node_id} 已保存产出`,
        detailText: `artifact：${event.artifact_id}
路径：${event.path}`
      }, event);
    case "model_stream_delta":
      return appendStreamingStatus(appendModelStream(next, event.node_id, event.attempt, event.text), event.node_id, event.attempt, event);
    case "node_completed": {
      const attempt = findAttempt(next, event.node_id);
      const formatted = nodeCompletedLog(event.node_id, event.status, event.result);
      return appendConversation(upsertNode(next, event.node_id, attempt, event.status), {
        kind: "status",
        nodeId: event.node_id,
        attempt,
        text: formatted.text,
        detailText: formatted.detailText
      }, event);
    }
    case "node_waiting_user": {
      const attempt = findAttempt(next, event.node_id);
      return appendConversation(
        upsertNode({ ...next, mode: "question", currentNodeId: event.node_id, questions: event.questions }, event.node_id, attempt, "waiting_user"),
        { kind: "status", nodeId: event.node_id, attempt, text: `${event.node_id} 需要用户补充信息`, detailText: questionDetail(event.questions) },
        event
      );
    }
    case "tool_invoked": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      const toolCallId = event.tool_call_id ?? `${event.node_id}:${next.tools.length + 1}`;
      return appendToolLog(appendConversation({
        ...next,
        tools: [
          ...next.tools,
          {
            nodeId: event.node_id,
            attempt,
            toolCallId,
            tool: event.tool,
            status: "running",
            input: event.input,
            expanded: false
          }
        ]
      }, { kind: "status", nodeId: event.node_id, attempt, text: `正在执行 ${event.tool}...`, detailText: getToolInputDetail(event.tool, event.input) }), event, attempt, toolCallId);
    }
    case "tool_completed": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      return updateToolLog(appendConversation(updateTool(next, event.tool_call_id, "completed", event.result), {
        kind: "status",
        nodeId: event.node_id,
        attempt,
        text: `${event.tool} 执行完成`,
        detailText: getToolResultDetail(event.result)
      }), event.tool_call_id, "completed", getToolResultDetail(event.result));
    }
    case "tool_failed": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      return updateToolLog(appendConversation(updateTool(next, event.tool_call_id, "failed", undefined, event.error), {
        kind: "status",
        nodeId: event.node_id,
        attempt,
        text: `${event.tool} 执行失败：${event.error}`,
        detailText: `错误：${event.error}`
      }), event.tool_call_id, "failed", `错误：${event.error}`);
    }
    case "permission_requested":
      return appendPermissionLog(appendConversation({
        ...next,
        mode: "permission",
        permissionRequests: [
          ...next.permissionRequests,
          {
            requestId: event.request_id,
            nodeId: event.node_id,
            attempt: event.attempt,
            toolCallId: event.tool_call_id,
            tool: event.tool,
            input: event.input,
            specifier: event.specifier,
            rule: event.rule
          }
        ]
      }, { kind: "status", nodeId: event.node_id, attempt: event.attempt, text: `需要确认是否允许 ${event.tool}`, detailText: permissionDetail(event.specifier, event.rule) }), event);
    case "permission_resolved":
      return updatePermissionLog(appendConversation({ ...next, mode: "running", permissionRequests: next.permissionRequests.filter((request) => request.requestId !== event.request_id) }, {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        text: event.decision === "allow_once" ? "已允许本次操作" : "已拒绝本次操作",
        detailText: `决定：${event.decision}`
      }), event.request_id, event.decision === "allow_once" ? "allowed" : "denied");
    case "node_interrupted":
      return appendConversation(upsertNode(next, event.node_id, event.attempt, "interrupted"), {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        text: `${event.node_id} 已中断`,
        detailText: `节点：${event.node_id}\n第 ${event.attempt} 次尝试`
      }, event);
    case "run_interrupted":
      return appendConversation({ ...next, mode: "interrupted" }, { kind: "status", text: "运行已中断", detailText: "原因：用户中断" }, event);
    case "run_failed":
      return appendConversation(
        { ...next, mode: "failed", error: event.error },
        { kind: "status", text: `运行失败：${event.error}`, detailText: event.detail ? `错误：${event.error}\n${event.detail}` : `错误：${event.error}` },
        event
      );
    case "run_completed":
      return appendConversation({ ...next, mode: "completed" }, { kind: "status", text: "运行完成", detailText: runResultDetail(event.result) }, event);
    default:
      return next;
  }
}

function upsertNode(state: TuiState, nodeId: string, attempt: number, status: TuiNodeState["status"]): TuiState {
  const existing = state.nodes.findIndex((node) => node.nodeId === nodeId && node.attempt === attempt);
  const node: TuiNodeState = { nodeId, attempt, status };
  if (existing === -1) return { ...state, nodes: [...state.nodes, node] };

  const nodes = [...state.nodes];
  nodes[existing] = node;
  return { ...state, nodes };
}

function appendModelStream(state: TuiState, nodeId: string, attempt: number, text: string): TuiState {
  const existing = state.modelStreams.findIndex((stream) => stream.nodeId === nodeId && stream.attempt === attempt);
  const stream: TuiModelStreamState = existing === -1
    ? { nodeId, attempt, text }
    : { ...state.modelStreams[existing], text: `${state.modelStreams[existing].text}${text}` };
  if (existing === -1) return { ...state, modelStreams: [...state.modelStreams, stream] };

  const modelStreams = [...state.modelStreams];
  modelStreams[existing] = stream;
  return { ...state, modelStreams };
}

function appendStreamingStatus(state: TuiState, nodeId: string, attempt: number, event: StoredEvent): TuiState {
  const text = `${nodeId} 正在生成响应...`;
  const exists = state.conversation.some((item) => item.kind === "status" && item.nodeId === nodeId && item.attempt === attempt && item.text === text);
  if (exists) return state;
  return appendConversation(state, { kind: "status", nodeId, attempt, text, detailText: "模型正在返回内容" }, event);
}

function appendConversation(state: TuiState, item: TuiConversationItem, event?: StoredEvent): TuiState {
  if (!item.text) return state;
  const conversation = [...state.conversation, item];
  if (!event) return { ...state, conversation };
  return { ...state, conversation, logMessages: [...state.logMessages, conversationToLogMessage(item, event)] };
}

function conversationToLogMessage(item: TuiConversationItem, event: StoredEvent): TuiLogMessage {
  return {
    id: logId(event),
    kind: item.kind,
    text: item.text,
    detailText: item.detailText,
    nodeId: item.nodeId,
    attempt: item.attempt
  };
}

function appendToolLog(state: TuiState, event: Extract<StoredEvent, { type: "tool_invoked" }>, attempt: number, toolCallId: string): TuiState {
  const tool: TuiToolLogMessage = {
    id: logId(event, toolCallId),
    kind: "tool",
    nodeId: event.node_id,
    attempt,
    toolCallId,
    tool: event.tool,
    status: "running",
    text: getToolDisplayName(event.tool),
    summary: getToolInputSummary(event.tool, event.input),
    detailText: getToolInputDetail(event.tool, event.input)
  };
  return { ...state, logMessages: [...state.logMessages, tool] };
}

function updateToolLog(state: TuiState, toolCallId: string | undefined, status: TuiToolLogMessage["status"], detailText: string): TuiState {
  if (!toolCallId) return state;
  return {
    ...state,
    logMessages: state.logMessages.map((item) => (item.kind === "tool" && item.toolCallId === toolCallId ? { ...item, status, detailText } : item))
  };
}

function appendPermissionLog(state: TuiState, event: Extract<StoredEvent, { type: "permission_requested" }>): TuiState {
  return {
    ...state,
    logMessages: [
      ...state.logMessages,
      {
        id: logId(event, event.request_id),
        kind: "permission",
        nodeId: event.node_id,
        attempt: event.attempt,
        requestId: event.request_id,
        toolCallId: event.tool_call_id,
        tool: event.tool,
        status: "pending",
        text: `需要确认是否允许 ${getToolDisplayName(event.tool)}`,
        detailText: permissionDetail(event.specifier, event.rule)
      }
    ]
  };
}

function updatePermissionLog(state: TuiState, requestId: string, status: "allowed" | "denied"): TuiState {
  const text = status === "allowed" ? "已允许本次操作" : "已拒绝本次操作";
  return {
    ...state,
    logMessages: state.logMessages.map((item) => (item.kind === "permission" && item.requestId === requestId ? { ...item, status, text } : item))
  };
}

function logId(event: StoredEvent, suffix: string = event.type): string {
  return `${event.seq}:${suffix}`;
}

function updateTool(state: TuiState, toolCallId: string | undefined, status: "completed" | "failed", result?: unknown, error?: string): TuiState {
  if (!toolCallId) return state;
  return {
    ...state,
    tools: state.tools.map((tool) => (tool.toolCallId === toolCallId ? { ...tool, status, result, error } : tool))
  };
}

function findAttempt(state: TuiState, nodeId: string): number {
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index];
    if (node.nodeId === nodeId) return node.attempt;
  }
  return 1;
}

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    if (typeof value.request === "string") return value.request;
    if (typeof value.answer === "string") return value.answer;
  }
  return readableValue(input);
}

function nodeCompletedLog(nodeId: string, status: "success" | "failure", result: unknown): { text: string; detailText: string } {
  const summary = resultSummary(result);
  const statusText = status === "success" ? "已完成" : "未通过";
  return {
    text: summary ? `${nodeId} ${statusText}：${summary}` : `${nodeId} ${statusText}`,
    detailText: nodeResultDetail(result)
  };
}

function resultSummary(result: unknown): string {
  if (result && typeof result === "object") {
    const summary = (result as Record<string, unknown>).summary;
    if (typeof summary === "string") return summary;
  }
  return "";
}

function nodeResultDetail(result: unknown): string {
  if (!result || typeof result !== "object") return readableValue(result);
  const value = result as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.summary === "string") lines.push(`摘要：${value.summary}`);
  if (typeof value.document === "string") lines.push(`文档：\n${value.document}`);
  if (Array.isArray(value.deliverables) && value.deliverables.length) lines.push(`产出：${value.deliverables.map(readableValue).join("、")}`);
  if (Array.isArray(value.questions) && value.questions.length) lines.push(`问题：${value.questions.map(readableValue).join("、")}`);
  const feedback = value.feedback;
  if (feedback && typeof feedback === "object") {
    const record = feedback as Record<string, unknown>;
    if (Array.isArray(record.defects) && record.defects.length) lines.push(`缺陷：${record.defects.map(readableValue).join("、")}`);
    if (Array.isArray(record.change_requests) && record.change_requests.length) lines.push(`变更请求：${record.change_requests.map(readableValue).join("、")}`);
  }
  const handoff = value.handoff;
  if (handoff && typeof handoff === "object") {
    const instruction = (handoff as Record<string, unknown>).instruction;
    if (typeof instruction === "string") lines.push(`交接：${instruction}`);
  }
  return lines.length ? lines.join("\n") : readableRecord(value);
}

function questionDetail(questions: unknown[]): string {
  if (!questions.length) return "等待用户补充信息";
  return questions.map((question) => `问题：${readableValue(question)}`).join("\n");
}

function permissionDetail(specifier: string, rule: string | undefined): string {
  return [`目标：${specifier || "未指定"}`, rule ? `规则：${rule}` : undefined].filter(Boolean).join("\n");
}

function runResultDetail(result: unknown): string {
  if (!result || typeof result !== "object") return readableValue(result);
  const value = result as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.status === "string") lines.push(`状态：${value.status}`);
  if (typeof value.workflow_id === "string") lines.push(`工作流：${value.workflow_id}`);
  if (Array.isArray(value.attempts)) lines.push(`节点尝试：${value.attempts.length}`);
  return lines.length ? lines.join("\n") : readableRecord(value);
}

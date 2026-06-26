import { visibleAssistantTextBeforeNodeResult } from "../team/nodeResult.js";
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
      return appendConversation({ ...next, questions: [] }, { kind: "user", nodeId: event.node_id, attempt: event.attempt, text: event.text }, event);
    case "node_started":
      return upsertNode({ ...next, mode: "running", currentNodeId: event.node_id, questions: [] }, event.node_id, event.attempt, "running");
    case "plan_review_requested":
      return appendConversation(
        upsertNode({
          ...next,
          mode: "waiting_plan_review",
          currentNodeId: event.node_id,
          pendingReview: { type: "plan", nodeId: event.node_id, attempt: event.attempt, document: event.document }
        }, event.node_id, event.attempt, "waiting_user"),
        { kind: "status", nodeId: event.node_id, attempt: event.attempt, text: `${event.node_id} 已生成计划，等待用户审核`, detailText: event.document, detailVisible: true },
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
    case "transition":
      return appendConversation({ ...next, mode: "running", currentNodeId: event.to }, {
        kind: "status",
        text: `流程流转：${event.from} -> ${event.to}（${event.reason}）`,
        detailText: `from：${event.from}
to：${event.to}
reason：${event.reason}`
      }, event);
    case "model_thinking_delta":
      return appendThinkingLog(next, event.node_id, event.attempt, event.text, event);
    case "model_stream_delta":
      return appendAssistantStreamLog(appendModelStream(next, event.node_id, event.attempt, event.text), event.node_id, event.attempt, event);
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
      const existing = next.nodes.find((node) => node.nodeId === event.node_id && node.attempt === attempt);
      const status = existing?.status === "failure" ? "failure" : "waiting_user";
      const mode = next.pendingReview && (next.mode === "plan_revision" || next.mode === "waiting_plan_review") ? "plan_revision" : "question";
      return appendConversation(
        upsertNode({ ...next, mode, currentNodeId: event.node_id, questions: event.questions }, event.node_id, attempt, status),
        { kind: "status", nodeId: event.node_id, attempt, text: `${event.node_id} 需要用户补充信息${questionSummary(event.questions)}`, detailText: questionDetail(event.questions) },
        event
      );
    }
    case "tool_invoked": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      const toolCallId = event.tool_call_id ?? `${event.node_id}:${next.tools.length + 1}`;
      const withTool = {
        ...next,
        tools: [
          ...next.tools,
          {
            nodeId: event.node_id,
            attempt,
            toolCallId,
            tool: event.tool,
            status: "running" as const,
            input: event.input,
            expanded: false
          }
        ]
      };
      const parentLogId = findToolParentAssistantLog(withTool, event.node_id, attempt);
      return appendToolLog(withTool, event, attempt, toolCallId, parentLogId);
    }
    case "tool_completed": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      return updateToolLog(updateTool(next, event.tool_call_id, "completed", event.result), event.tool_call_id, "completed", getToolResultDetail(event.result));
    }
    case "tool_failed": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      return updateToolLog(updateTool(next, event.tool_call_id, "failed", undefined, event.error), event.tool_call_id, "failed", `错误：${event.error}`);
    }
    case "permission_requested":
      return appendPermissionLog({
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
      }, event);
    case "permission_resolved":
      return updatePermissionLog({
        ...next,
        mode: "running",
        permissionRequests: next.permissionRequests.filter((request) => request.requestId !== event.request_id)
      }, event.request_id, event.decision === "allow_once" ? "allowed" : "denied");
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
function appendAssistantStreamLog(state: TuiState, nodeId: string, attempt: number, event: StoredEvent): TuiState {
  const stream = state.modelStreams.find((s) => s.nodeId === nodeId && s.attempt === attempt);
  const streamText = visibleAssistantStreamText(stream?.text ?? "");
  if (!streamText) return state;
  const previousEnd = currentAssistantStreamEnd(state.logMessages, nodeId, attempt);
  if (streamText.length < previousEnd) return trimAssistantStreamLog(state, nodeId, attempt, streamText, previousEnd);
  if (streamText.length === previousEnd) return state;
  const delta = streamText.slice(previousEnd);
  const last = [...state.logMessages].reverse().find(
    (item) => item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt && item.source === "model_stream"
  );
  if (!last || hasChildLog(state.logMessages, last.id)) {
    return appendConversation(state, { kind: "assistant", nodeId, attempt, text: delta, source: "model_stream", streamEnd: streamText.length }, event);
  }
  const text = `${last.text}${delta}`;
  return {
    ...state,
    conversation: updateAssistantConversation(state.conversation, nodeId, attempt, text, streamText.length),
    logMessages: state.logMessages.map((item) => item.id === last.id ? { ...item, text, streamEnd: streamText.length } : item)
  };
}
function appendThinkingLog(state: TuiState, nodeId: string, attempt: number, text: string, event: StoredEvent): TuiState {
  if (!text) return state;
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind !== "status" || item.nodeId !== nodeId || item.attempt !== attempt || item.text !== "Reasoning") continue;
    const logMessages = [...state.logMessages];
    logMessages[index] = { ...item, detailText: `${item.detailText ?? ""}${text}`, detailVisible: true };
    return { ...state, logMessages };
  }
  return {
    ...state,
    logMessages: [
      ...state.logMessages,
      {
        id: logId(event, "thinking"),
        kind: "status",
        nodeId,
        attempt,
        text: "Reasoning",
        detailText: text,
        detailVisible: true
      }
    ]
  };
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
    detailVisible: item.detailVisible,
    nodeId: item.nodeId,
    attempt: item.attempt,
    source: item.source,
    streamEnd: item.streamEnd
  };
}
function findToolParentAssistantLog(state: TuiState, nodeId: string, attempt: number): string | undefined {
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt) return item.id;
    if (item.parentLogId) continue;
    if (isPermissionFlowLog(item, nodeId, attempt)) continue;
    if (isThinkingFlowLog(item, nodeId, attempt)) continue;
    return undefined;
  }
  return undefined;
}
function isPermissionFlowLog(item: TuiLogMessage, nodeId: string, attempt: number): boolean {
  if (item.nodeId !== nodeId || item.attempt !== attempt) return false;
  return item.kind === "permission";
}
function isThinkingFlowLog(item: TuiLogMessage, nodeId: string, attempt: number): boolean {
  if (item.nodeId !== nodeId || item.attempt !== attempt) return false;
  return item.kind === "status" && item.text === "Reasoning";
}
function updateAssistantConversation(items: TuiConversationItem[], nodeId: string, attempt: number, text: string, streamEnd: number): TuiConversationItem[] {
  const index = [...items].reverse().findIndex((item) => item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt && item.source === "model_stream");
  if (index === -1) return items;
  const actualIndex = items.length - 1 - index;
  const next = [...items];
  next[actualIndex] = { ...next[actualIndex], text, streamEnd };
  return next;
}
function trimAssistantStreamLog(state: TuiState, nodeId: string, attempt: number, streamText: string, previousEnd: number): TuiState {
  const last = [...state.logMessages].reverse().find((item) => item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt && item.source === "model_stream");
  if (!last || last.kind !== "assistant") return state;
  const lastEnd = last.streamEnd ?? previousEnd;
  const lastStart = Math.max(0, lastEnd - last.text.length);
  const text = streamText.slice(lastStart);
  return {
    ...state,
    conversation: updateAssistantConversation(state.conversation, nodeId, attempt, text, streamText.length),
    logMessages: state.logMessages.map((item) => item.id === last.id ? { ...item, text, streamEnd: streamText.length } : item)
  };
}
function currentAssistantStreamEnd(items: TuiLogMessage[], nodeId: string, attempt: number): number {
  return items.reduce((max, item) => {
    if (item.kind !== "assistant" || item.nodeId !== nodeId || item.attempt !== attempt || item.source !== "model_stream") return max;
    return Math.max(max, item.streamEnd ?? 0);
  }, 0);
}
function hasChildLog(items: TuiLogMessage[], parentLogId: string): boolean {
  return items.some((item) => item.parentLogId === parentLogId);
}
function visibleAssistantStreamText(text: string): string {
  return visibleAssistantTextBeforeNodeResult(text);
}
function appendToolLog(state: TuiState, event: Extract<StoredEvent, { type: "tool_invoked" }>, attempt: number, toolCallId: string, parentLogId?: string): TuiState {
  const tool: TuiToolLogMessage = {
    id: logId(event, toolCallId),
    kind: "tool",
    nodeId: event.node_id,
    attempt,
    toolCallId,
    parentLogId,
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
function questionSummary(questions: unknown[]): string {
  const first = questions[0];
  return first === undefined ? "" : `：${readableValue(first)}`;
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

import { addModelUsage, emptyModelUsage } from "../model/usage.js";
import { visibleAssistantTextBeforeNodeResult } from "../team/nodeResult.js";
import { StoredEvent } from "../harness/events.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import { CONVERSATION_INTERRUPTED_QUESTION_ID, CONVERSATION_INTERRUPTED_TEXT } from "../workflow/state.js";
import { TuiLogMessage, TuiToolLogMessage } from "./logTypes.js";
import { TuiConversationItem, TuiModelRetryState, TuiModelStreamState, TuiNodeState, TuiState } from "./state.js";
import { getCompactToolResultDetail, getToolDisplayName, getToolInputDetail, getToolInputSummary, getToolResultDetail, readableRecord, readableValue } from "./toolDisplay.js";
export function initialTuiState(input: { cwd: string; inputPermissionMode?: PermissionMode }): TuiState {
  return {
    cwd: input.cwd,
    mode: "boot",
    runState: "starting",
    inputPermissionMode: input.inputPermissionMode ?? "default",
    defaultExecutionMode: defaultExecutionModeFrom(input.inputPermissionMode),
    sessionUsage: emptyModelUsage(),
    modelRequestCount: 0,
    nodes: [],
    suspendedStack: [],
    tools: [],
    permissionRequests: [],
    modelStreams: [],
    modelStreamLocations: {},
    conversation: [],
    logMessages: [],
    questions: [],
    resumeRuns: []
  };
}
function defaultExecutionModeFrom(mode: PermissionMode | undefined): TuiState["defaultExecutionMode"] {
  return mode === "fullAccess" ? "fullAccess" : "default";
}
function nextSuspendedStack(stack: string[], event: Extract<StoredEvent, { type: "transition" }>): string[] {
  const next = [...stack];
  if (event.reason === "backward") {
    next.push(event.from);
    return next;
  }
  if (event.reason === "forward" && next.at(-1) === event.to) next.pop();
  return next;
}
export function resetTuiRunState(state: TuiState, input: { workflowId: string; runId: string; preserveLogs?: boolean; inputPermissionMode?: PermissionMode }): TuiState {
  const reset: TuiState = {
    ...initialTuiState({ cwd: state.cwd, inputPermissionMode: input.inputPermissionMode ?? state.inputPermissionMode }),
    defaultExecutionMode: state.defaultExecutionMode,
    sessionUsage: state.sessionUsage,
    modelRequestCount: state.modelRequestCount,
    workflowId: input.workflowId,
    runId: input.runId,
    mode: "running",
    runState: "working"
  };
  if (!input.preserveLogs) return reset;
  return {
    ...reset,
    planSession: state.planSession,
    conversation: state.conversation,
    logMessages: state.logMessages,
    modelStreamLocations: state.modelStreamLocations
  };
}
export function reduceStoredEvent(state: TuiState, event: StoredEvent): TuiState {
  const next = state;
  switch (event.type) {
    case "model_response_recorded": {
      const withModel = updateNodeDetails(clearTuiModelRetry(next), event.node_id, event.attempt, event.activation, { model: event.model });
      return {
        ...withModel,
        runState: "working",
        sessionUsage: addModelUsage(withModel.sessionUsage, event.usage),
        modelRequestCount: withModel.modelRequestCount + 1
      };
    }
    case "node_context_updated":
      return updateNodeDetails(next, event.node_id, event.attempt, event.activation, {
        contextTokens: event.context_tokens,
        contextWindow: event.context_window,
        contextLimit: event.context_limit
      });
    case "node_context_compaction_started":
      return appendConversation({ ...next, runState: "working" }, {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        text: `${event.node_id} 开始上下文压缩`,
        detailText: `阶段：${event.phase}\n原因：${event.reason}\n模型：${event.model}\n压缩前：${event.context_tokens}\n自动压缩上限：${event.context_limit}\n窗口：${event.window_number}`
      }, event);
    case "node_context_compacted": {
      const withContext = updateNodeDetails({ ...next, runState: "thinking" }, event.node_id, event.attempt, event.activation, {
        contextTokens: event.context_tokens_after,
        contextLimit: event.context_limit
      });
      return appendConversation(withContext, {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        text: `${event.node_id} 已完成上下文压缩`,
        detailText: `阶段：${event.phase}\n原因：${event.reason}\n模型：${event.model}\n压缩前：${event.context_tokens_before}\n压缩后：${event.context_tokens_after}\n窗口：${event.window_number}`
      }, event);
    }
    case "node_context_compaction_failed":
      return appendConversation({ ...next, runState: "thinking" }, {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        text: `${event.node_id} 上下文压缩失败`,
        detailText: `阶段：${event.phase}\n原因：${event.reason}\n模型：${event.model}\n${event.error}`
      }, event);
    case "run_started":
      return appendConversation({ ...next, workflowId: event.workflow_id, mode: "running", runState: "working", activityNotice: undefined }, { kind: "user", text: inputText(event.input) }, event);
    case "user_message":
      return appendConversation({ ...next, questions: [], activityNotice: undefined, runState: "thinking" }, { kind: "user", nodeId: event.node_id, attempt: event.attempt, text: event.text }, event);
    case "user_input_injected":
      return appendConversation({ ...next, questions: [], activityNotice: undefined, runState: "thinking" }, { kind: "user", nodeId: event.node_id, attempt: event.attempt, activation: event.activation, text: event.text }, event);
    case "user_input_deferred":
      return next;
    case "node_started":
      return upsertNode({ ...next, mode: "running", runState: "thinking", currentNodeId: event.node_id, questions: [], activityNotice: undefined }, event.node_id, event.attempt, event.activation ?? 1, "running");
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
      return appendConversation({ ...next, mode: "running", runState: "working", currentNodeId: event.to, suspendedStack: nextSuspendedStack(next.suspendedStack, event) }, {
        kind: "status",
        text: `流程流转：${event.from} -> ${event.to}（${event.reason}）`,
        detailText: `from：${event.from}
to：${event.to}
reason：${event.reason}`
      }, event);
    case "model_thinking_delta": {
      const activation = event.activation ?? findActivation(next, event.node_id);
      return appendThinkingLog({ ...next, runState: "thinking" }, event.node_id, event.attempt, activation, event.text, event);
    }
    case "model_stream_delta": {
      const activation = event.activation ?? findActivation(next, event.node_id);
      return appendAssistantStreamLog(appendModelStream({ ...next, runState: "thinking" }, event.node_id, event.attempt, activation, event.text), event.node_id, event.attempt, activation, event);
    }
    case "model_retry_scheduled": {
      const activation = event.activation ?? findActivation(next, event.node_id);
      const rolledBack = rollbackRetryStream({ ...next, runState: "thinking" }, event.node_id, event.attempt, activation, event.discarded_content_chars, event.discarded_thinking_chars);
      return applyTuiModelRetry(rolledBack, {
        nodeId: event.node_id,
        attempt: event.attempt,
        activation,
        operation: event.operation,
        phase: event.phase,
        retryAttempt: event.retry_attempt,
        maxRetries: event.max_retries,
        retryInMs: event.retry_in_ms,
        retryAt: event.retry_at,
        errorKind: event.error_kind,
        status: event.status,
        error: event.error,
        detail: event.detail
      });
    }
    case "node_completed": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      const activation = event.activation ?? findActivation(next, event.node_id);
      const formatted = nodeCompletedLog(event.node_id, event.status, event.result);
      const status = event.status === "success" ? "completed" : event.status;
      return appendConversation(upsertNode({ ...next, runState: "working" }, event.node_id, attempt, activation, status), {
        kind: "status",
        nodeId: event.node_id,
        attempt,
        text: formatted.text,
        detailText: formatted.detailText
      }, event);
    }
    case "node_waiting_user": {
      const attempt = findAttempt(next, event.node_id);
      const activation = event.activation ?? findActivation(next, event.node_id);
      const existing = next.nodes.find((node) => node.nodeId === event.node_id && node.attempt === attempt);
      const status = existing?.status === "failure" ? "failure" : "waiting_user";
      const isConversationInterrupted = event.questions.some((question) => (
        question !== null
        && typeof question === "object"
        && (question as { id?: unknown }).id === CONVERSATION_INTERRUPTED_QUESTION_ID
      ));
      const waitingState = upsertNode({
        ...next,
        mode: "question",
        runState: "waiting",
        currentNodeId: event.node_id,
        questions: event.questions,
        activityNotice: isConversationInterrupted ? { text: CONVERSATION_INTERRUPTED_TEXT, tone: "warning" } : undefined
      }, event.node_id, attempt, activation, status);
      if (isConversationInterrupted) return waitingState;
      return appendConversation(
        waitingState,
        { kind: "status", nodeId: event.node_id, attempt, text: `${event.node_id} 需要用户补充信息${questionSummary(event.questions)}`, detailText: questionDetail(event.questions) },
        event
      );
    }
    case "tool_invoked": {
      const attempt = event.attempt ?? findAttempt(next, event.node_id);
      const toolCallId = event.tool_call_id ?? `${event.node_id}:${next.tools.length + 1}`;
      const withTool = {
        ...next,
        runState: "working" as const,
        tools: [
          ...next.tools,
          {
            nodeId: event.node_id,
            attempt,
            activation: event.activation ?? findActivation(next, event.node_id),
            toolCallId,
            tool: event.tool,
            status: "running" as const,
            input: event.input,
            expanded: false
          }
        ]
      };
      const activation = event.activation ?? findActivation(next, event.node_id);
      const parentLogId = findToolParentAssistantLog(withTool, event.node_id, attempt, activation);
      return appendToolLog(withTool, event, attempt, activation, toolCallId, parentLogId);
    }
    case "tool_completed":
      return updateRunStateAfterTool(updateToolLog(updateTool(next, event.tool_call_id, "completed", event.result), event.tool_call_id, "completed", getToolResultDetail(event.result), getCompactToolResultDetail(event.result)));
    case "tool_failed":
      return updateRunStateAfterTool(updateToolLog(updateTool(next, event.tool_call_id, "failed", undefined, event.error), event.tool_call_id, "failed", `错误：${event.error}`));
    case "permission_requested":
      return appendPermissionLog({
        ...next,
        mode: "permission",
        runState: "waiting",
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
        runState: "working",
        permissionRequests: next.permissionRequests.filter((request) => request.requestId !== event.request_id)
      }, event.request_id, event.decision === "allow_once" ? "allowed" : "denied");
    case "node_interrupted":
      return appendConversation(upsertNode(next, event.node_id, event.attempt, findActivation(next, event.node_id), "interrupted"), {
        kind: "status",
        nodeId: event.node_id,
        attempt: event.attempt,
        text: `${event.node_id} 已中断`,
        detailText: `节点：${event.node_id}\n第 ${event.attempt} 次尝试`
      }, event);
    case "run_interrupted":
      return appendConversation({ ...clearTuiModelRetry(next), mode: "interrupted", runState: "ready" }, { kind: "status", text: "运行已中断", detailText: "原因：用户中断" }, event);
    case "run_failed":
      return appendConversation(
        { ...clearTuiModelRetry(next), mode: "failed", runState: "ready", error: event.error },
        { kind: "status", text: `运行失败：${event.error}`, detailText: event.detail ? `错误：${event.error}\n${event.detail}` : `错误：${event.error}` },
        event
      );
    case "run_completed":
      return appendConversation({ ...clearTuiModelRetry(next), mode: "completed", runState: "ready" }, { kind: "status", text: "运行完成", detailText: runResultDetail(event.result) }, event);
    case "run_cancelled":
      return appendConversation({ ...clearTuiModelRetry(next), mode: "interrupted", runState: "ready" }, { kind: "status", text: "运行已取消", detailText: event.reason }, event);
    default:
      return next;
  }
}

function updateRunStateAfterTool(state: TuiState): TuiState {
  return { ...state, runState: state.tools.some((tool) => tool.status === "running") ? "working" : "thinking" };
}

export function applyTuiModelRetry(state: TuiState, retry: TuiModelRetryState): TuiState {
  const seconds = Math.max(0, Math.ceil(retry.retryInMs / 1000));
  const status = retry.status === undefined ? "" : `\nHTTP 状态：${retry.status}`;
  const detail = retry.detail ? `\n${retry.detail}` : "";
  const log: TuiLogMessage = {
    id: `model-retry:${retry.nodeId ?? "runtime"}:${retry.attempt ?? 1}`,
    kind: "status",
    source: "model_retry",
    nodeId: retry.nodeId,
    attempt: retry.attempt,
    activation: retry.activation,
    text: `模型请求将在 ${seconds} 秒后重试（${retry.retryAttempt}/${retry.maxRetries}）`,
    detailText: `操作：${retry.operation}\n阶段：${retry.phase}\n错误类型：${retry.errorKind}${status}\n错误：${retry.error}${detail}`
  };
  return {
    ...state,
    activeModelRetry: retry,
    logMessages: [...state.logMessages.filter((item) => !(item.kind === "status" && item.source === "model_retry")), log]
  };
}

export function clearTuiModelRetry(state: TuiState): TuiState {
  if (!state.activeModelRetry && !state.logMessages.some((item) => item.kind === "status" && item.source === "model_retry")) return state;
  return {
    ...state,
    activeModelRetry: undefined,
    logMessages: state.logMessages.filter((item) => !(item.kind === "status" && item.source === "model_retry"))
  };
}

function rollbackRetryStream(
  state: TuiState,
  nodeId: string,
  attempt: number,
  activation: number,
  discardedContentChars: number,
  discardedThinkingChars: number
): TuiState {
  let next = state;
  if (discardedContentChars > 0) {
    const index = next.modelStreams.findIndex((stream) => stream.nodeId === nodeId && stream.attempt === attempt && (stream.activation ?? 1) === activation);
    if (index !== -1) {
      const stream = next.modelStreams[index]!;
      const text = stream.text.slice(0, Math.max(0, stream.text.length - discardedContentChars));
      const modelStreams = [...next.modelStreams];
      if (text) modelStreams[index] = { ...stream, text };
      else modelStreams.splice(index, 1);
      const visibleLength = visibleAssistantStreamText(text).length;
      next = {
        ...next,
        modelStreams,
        conversation: trimAssistantConversation(next.conversation, nodeId, attempt, activation, visibleLength),
        logMessages: trimAssistantLogs(next.logMessages, nodeId, attempt, activation, visibleLength)
      };
    }
  }
  if (discardedThinkingChars > 0) next = rollbackThinkingLog(next, nodeId, attempt, activation, discardedThinkingChars);
  return next;
}

function trimAssistantLogs(items: TuiLogMessage[], nodeId: string, attempt: number, activation: number, visibleLength: number): TuiLogMessage[] {
  return items.flatMap((item) => {
    if (item.kind !== "assistant" || item.source !== "model_stream" || item.nodeId !== nodeId || item.attempt !== attempt || item.activation !== activation) return [item];
    const end = item.streamEnd ?? 0;
    const start = Math.max(0, end - item.text.length);
    if (start >= visibleLength) return [];
    if (end <= visibleLength) return [item];
    return [{ ...item, text: item.text.slice(0, visibleLength - start), streamEnd: visibleLength }];
  });
}

function trimAssistantConversation(items: TuiConversationItem[], nodeId: string, attempt: number, activation: number, visibleLength: number): TuiConversationItem[] {
  return items.flatMap((item) => {
    if (item.kind !== "assistant" || item.source !== "model_stream" || item.nodeId !== nodeId || item.attempt !== attempt || item.activation !== activation) return [item];
    const end = item.streamEnd ?? 0;
    const start = Math.max(0, end - item.text.length);
    if (start >= visibleLength) return [];
    if (end <= visibleLength) return [item];
    return [{ ...item, text: item.text.slice(0, visibleLength - start), streamEnd: visibleLength }];
  });
}

function rollbackThinkingLog(state: TuiState, nodeId: string, attempt: number, activation: number, discardedChars: number): TuiState {
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind !== "status" || item.text !== "Reasoning" || item.nodeId !== nodeId || item.attempt !== attempt || item.activation !== activation) continue;
    const detailText = (item.detailText ?? "").slice(0, Math.max(0, (item.detailText ?? "").length - discardedChars));
    const logMessages = [...state.logMessages];
    if (detailText) logMessages[index] = { ...item, detailText };
    else logMessages.splice(index, 1);
    return { ...state, logMessages };
  }
  return state;
}
function upsertNode(state: TuiState, nodeId: string, attempt: number, activation: number, status: TuiNodeState["status"]): TuiState {
  const existing = state.nodes.findIndex((node) => node.nodeId === nodeId && node.attempt === attempt);
  const previous = existing === -1 ? undefined : state.nodes[existing];
  const sameActivation = previous !== undefined && (previous.activation ?? 1) === activation;
  const node: TuiNodeState = sameActivation
    ? { ...previous, nodeId, attempt, activation, status }
    : { nodeId, attempt, activation, status };
  if (existing === -1) return { ...state, nodes: [...state.nodes, node] };
  const nodes = [...state.nodes];
  nodes[existing] = node;
  return { ...state, nodes };
}
function updateNodeDetails(
  state: TuiState,
  nodeId: string,
  attempt: number,
  activation: number | undefined,
  details: Partial<Pick<TuiNodeState, "model" | "contextTokens" | "contextWindow" | "contextLimit">>
): TuiState {
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index];
    if (node.nodeId !== nodeId || node.attempt !== attempt) continue;
    if (activation !== undefined && (node.activation ?? 1) !== activation) continue;
    const nodes = [...state.nodes];
    nodes[index] = { ...node, ...details };
    return { ...state, nodes };
  }
  return state;
}
function appendModelStream(state: TuiState, nodeId: string, attempt: number, activation: number, text: string): TuiState {
  const existing = state.modelStreams.findIndex((stream) => stream.nodeId === nodeId && stream.attempt === attempt && (stream.activation ?? 1) === activation);
  const stream: TuiModelStreamState = existing === -1
    ? { nodeId, attempt, activation, text }
    : { ...state.modelStreams[existing], text: `${state.modelStreams[existing].text}${text}` };
  if (existing === -1) return { ...state, modelStreams: [...state.modelStreams, stream] };
  const modelStreams = [...state.modelStreams];
  modelStreams[existing] = stream;
  return { ...state, modelStreams };
}
function appendAssistantStreamLog(state: TuiState, nodeId: string, attempt: number, activation: number, event: StoredEvent): TuiState {
  const stream = state.modelStreams.find((item) => item.nodeId === nodeId && item.attempt === attempt && (item.activation ?? 1) === activation);
  const streamText = visibleAssistantStreamText(stream?.text ?? "");
  if (!streamText) return state;
  const location = resolveModelStreamLocation(state, nodeId, attempt, activation);
  const last = location ? state.logMessages[location.logIndex] : undefined;
  const previousEnd = last?.kind === "assistant" ? last.streamEnd ?? 0 : 0;
  if (streamText.length < previousEnd) return trimAssistantStreamLog(state, nodeId, attempt, activation, streamText, previousEnd);
  if (streamText.length === previousEnd) return state;
  const delta = streamText.slice(previousEnd);
  if (!location || !last || last.kind !== "assistant" || hasChildLogAfter(state.logMessages, last.id, location.logIndex)) {
    return appendConversation(state, { kind: "assistant", nodeId, attempt, activation, text: delta, source: "model_stream", streamEnd: streamText.length }, event);
  }
  const text = `${last.text}${delta}`;
  const logMessages = [...state.logMessages];
  logMessages[location.logIndex] = { ...last, text, streamEnd: streamText.length };
  return {
    ...state,
    conversation: updateAssistantConversation(state.conversation, location.conversationIndex, text, streamText.length),
    logMessages,
    modelStreamLocations: { ...state.modelStreamLocations, [modelStreamKey(nodeId, attempt, activation)]: location }
  };
}
function appendThinkingLog(state: TuiState, nodeId: string, attempt: number, activation: number, text: string, event: StoredEvent): TuiState {
  if (!text) return state;
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind !== "status" || item.nodeId !== nodeId || item.attempt !== attempt || item.activation !== activation || item.text !== "Reasoning") continue;
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
        activation,
        text: "Reasoning",
        detailText: text,
        detailVisible: true
      }
    ]
  };
}
function appendConversation(state: TuiState, item: TuiConversationItem, event?: StoredEvent): TuiState {
  if (!item.text) return state;
  const conversationIndex = state.conversation.length;
  const conversation = [...state.conversation, item];
  if (!event) return { ...state, conversation };
  const logIndex = state.logMessages.length;
  const logMessages = [...state.logMessages, conversationToLogMessage(item, event)];
  if (item.kind !== "assistant" || item.source !== "model_stream" || item.nodeId === undefined || item.attempt === undefined) {
    return { ...state, conversation, logMessages };
  }
  const activation = item.activation ?? 1;
  return {
    ...state,
    conversation,
    logMessages,
    modelStreamLocations: {
      ...state.modelStreamLocations,
      [modelStreamKey(item.nodeId, item.attempt, activation)]: { conversationIndex, logIndex }
    }
  };
}
function conversationToLogMessage(item: TuiConversationItem, event: StoredEvent): TuiLogMessage {
  const base = {
    id: logId(event),
    text: item.text,
    detailText: item.detailText,
    detailVisible: item.detailVisible,
    nodeId: item.nodeId,
    attempt: item.attempt,
    activation: item.activation
  };
  if (item.kind === "assistant") return { ...base, kind: "assistant", source: item.source, streamEnd: item.streamEnd };
  return { ...base, kind: item.kind };
}
function findToolParentAssistantLog(state: TuiState, nodeId: string, attempt: number, activation: number): string | undefined {
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt && item.activation === activation) return item.id;
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
function updateAssistantConversation(items: TuiConversationItem[], index: number, text: string, streamEnd: number): TuiConversationItem[] {
  const current = items[index];
  if (!current) return items;
  const next = [...items];
  next[index] = { ...current, text, streamEnd };
  return next;
}
function trimAssistantStreamLog(state: TuiState, nodeId: string, attempt: number, activation: number, streamText: string, previousEnd: number): TuiState {
  const location = resolveModelStreamLocation(state, nodeId, attempt, activation);
  const last = location ? state.logMessages[location.logIndex] : undefined;
  if (!location || !last || last.kind !== "assistant") return state;
  const lastEnd = last.streamEnd ?? previousEnd;
  const lastStart = Math.max(0, lastEnd - last.text.length);
  const text = streamText.slice(lastStart);
  const logMessages = [...state.logMessages];
  logMessages[location.logIndex] = { ...last, text, streamEnd: streamText.length };
  return {
    ...state,
    conversation: updateAssistantConversation(state.conversation, location.conversationIndex, text, streamText.length),
    logMessages,
    modelStreamLocations: { ...state.modelStreamLocations, [modelStreamKey(nodeId, attempt, activation)]: location }
  };
}
function resolveModelStreamLocation(state: TuiState, nodeId: string, attempt: number, activation: number): { conversationIndex: number; logIndex: number } | undefined {
  const cached = state.modelStreamLocations[modelStreamKey(nodeId, attempt, activation)];
  const cachedLog = cached ? state.logMessages[cached.logIndex] : undefined;
  const cachedConversation = cached ? state.conversation[cached.conversationIndex] : undefined;
  if (
    cachedLog?.kind === "assistant" &&
    cachedLog.nodeId === nodeId &&
    cachedLog.attempt === attempt &&
    cachedLog.activation === activation &&
    cachedLog.source === "model_stream" &&
    cachedConversation?.kind === "assistant" &&
    cachedConversation.nodeId === nodeId &&
    cachedConversation.attempt === attempt &&
    cachedConversation.activation === activation &&
    cachedConversation.source === "model_stream"
  ) {
    return cached;
  }
  let logIndex = -1;
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt && item.activation === activation && item.source === "model_stream") {
      logIndex = index;
      break;
    }
  }
  let conversationIndex = -1;
  for (let index = state.conversation.length - 1; index >= 0; index -= 1) {
    const item = state.conversation[index];
    if (item.kind === "assistant" && item.nodeId === nodeId && item.attempt === attempt && item.activation === activation && item.source === "model_stream") {
      conversationIndex = index;
      break;
    }
  }
  return logIndex >= 0 && conversationIndex >= 0 ? { conversationIndex, logIndex } : undefined;
}
function modelStreamKey(nodeId: string, attempt: number, activation: number): string {
  return `${nodeId}:${attempt}:${activation}`;
}
function hasChildLogAfter(items: TuiLogMessage[], parentLogId: string, parentIndex: number): boolean {
  for (let index = parentIndex + 1; index < items.length; index += 1) {
    if (items[index].parentLogId === parentLogId) return true;
  }
  return false;
}
function visibleAssistantStreamText(text: string): string {
  return visibleAssistantTextBeforeNodeResult(text);
}
function appendToolLog(state: TuiState, event: Extract<StoredEvent, { type: "tool_invoked" }>, attempt: number, activation: number, toolCallId: string, parentLogId?: string): TuiState {
  const tool: TuiToolLogMessage = {
    id: logId(event, toolCallId),
    kind: "tool",
    nodeId: event.node_id,
    attempt,
    activation,
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
function updateToolLog(state: TuiState, toolCallId: string | undefined, status: TuiToolLogMessage["status"], detailText: string, compactDetailText?: string): TuiState {
  if (!toolCallId) return state;
  return {
    ...state,
    logMessages: state.logMessages.map((item) => (item.kind === "tool" && item.toolCallId === toolCallId ? { ...item, status, detailText, compactDetailText } : item))
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
function findActivation(state: TuiState, nodeId: string): number {
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index];
    if (node.nodeId === nodeId) return node.activation ?? 1;
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
function nodeCompletedLog(nodeId: string, status: "success" | "failure" | "completed" | "suspended" | "retrying", result: unknown): { text: string; detailText: string } {
  const summary = resultSummary(result);
  const statusText = status === "success" || status === "completed" ? "已完成" : status === "suspended" ? "已挂起并退回" : status === "retrying" ? "保持当前节点并重试" : "执行失败";
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

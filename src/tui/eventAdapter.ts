import { StoredEvent } from "../harness/events.js";
import { TuiNodeState, TuiState } from "./state.js";

export function initialTuiState(input: { cwd: string }): TuiState {
  return {
    cwd: input.cwd,
    mode: "boot",
    nodes: [],
    tools: [],
    permissionRequests: [],
    questions: [],
    timeline: []
  };
}

export function reduceStoredEvent(state: TuiState, event: StoredEvent): TuiState {
  const next: TuiState = { ...state, timeline: [...state.timeline, event.type] };

  switch (event.type) {
    case "run_started":
      return { ...next, workflowId: event.workflow_id, mode: "running" };
    case "node_started":
      return upsertNode({ ...next, mode: "running", currentNodeId: event.node_id }, event.node_id, event.attempt, "running");
    case "node_completed":
      return upsertNode(next, event.node_id, findAttempt(next, event.node_id), event.status);
    case "node_waiting_user":
      return upsertNode({ ...next, mode: "question", currentNodeId: event.node_id, questions: event.questions }, event.node_id, findAttempt(next, event.node_id), "waiting_user");
    case "tool_invoked":
      return {
        ...next,
        tools: [
          ...next.tools,
          {
            nodeId: event.node_id,
            attempt: event.attempt ?? findAttempt(next, event.node_id),
            toolCallId: event.tool_call_id ?? `${event.node_id}:${next.tools.length + 1}`,
            tool: event.tool,
            status: "running",
            input: event.input,
            expanded: false
          }
        ]
      };
    case "tool_completed":
      return updateTool(next, event.tool_call_id, "completed", event.result);
    case "tool_failed":
      return updateTool(next, event.tool_call_id, "failed", undefined, event.error);
    case "permission_requested":
      return {
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
      };
    case "permission_resolved":
      return { ...next, mode: "running", permissionRequests: next.permissionRequests.filter((request) => request.requestId !== event.request_id) };
    case "node_interrupted":
      return upsertNode(next, event.node_id, event.attempt, "interrupted");
    case "run_interrupted":
      return { ...next, mode: "interrupted" };
    case "run_failed":
      return { ...next, mode: "failed", error: event.error };
    case "run_completed":
      return { ...next, mode: "completed" };
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

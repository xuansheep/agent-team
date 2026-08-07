import type { StoredEvent } from "../harness/events.js";
import { ArtifactStore, type ArtifactRecord } from "../storage/artifacts.js";
import type { RunStore } from "../storage/runStore.js";
import { nodeResultSchema, type NodeResult } from "../team/nodeResult.js";
import type { WorkflowState } from "./state.js";

export type DossierNodeResult = {
  seq: number;
  ts: string;
  node_id: string;
  attempt: number;
  activation: number;
  status: "success" | "failure" | "completed" | "suspended" | "retrying";
  result: NodeResult;
};

export type DossierToolLifecycle = {
  seq: number;
  ts: string;
  node_id: string;
  attempt?: number;
  activation?: number;
  tool_call_id?: string;
  tool: string;
  status: "invoked" | "completed" | "failed";
  error?: string;
};

export type DossierPermissionLifecycle = {
  seq: number;
  ts: string;
  request_id: string;
  node_id: string;
  attempt: number;
  tool: string;
  status: "requested" | "allowed" | "denied";
  rule?: string;
};

export type DossierProcessLifecycle = {
  seq: number;
  ts: string;
  node_id: string;
  attempt?: number;
  activation?: number;
  process_id: string;
  pid: number;
  status: "started" | "stopped" | "cleanup_failed";
  executable?: string;
  reason?: string;
  exit_code?: number | null;
  error?: string;
};

export type WorkflowRunDossier = {
  run_id: string;
  workflow_id: string;
  status: WorkflowState["status"];
  current_node_id?: string;
  created_at?: string;
  updated_at?: string;
  rework_count: number;
  rework_limit: number;
  attempts: Array<{
    node_id: string;
    attempt: number;
    activation: number;
    status: WorkflowState["attempts"][number]["status"];
  }>;
  node_results: DossierNodeResult[];
  artifacts: ArtifactRecord[];
  lifecycle: {
    tools: DossierToolLifecycle[];
    permissions: DossierPermissionLifecycle[];
    processes: DossierProcessLifecycle[];
    failures: Array<{ seq: number; ts: string; scope: "tool" | "run" | "process"; error: string }>;
    model_response_count: number;
    user_interaction_count: number;
  };
  omitted_payloads: readonly [
    "model_stream_delta",
    "model_thinking_delta",
    "raw_tool_input",
    "raw_tool_result",
    "workflow_dialogue"
  ];
};

export async function buildWorkflowRunDossier(store: RunStore, runId: string): Promise<WorkflowRunDossier> {
  const [state, events] = await Promise.all([
    store.loadState(runId),
    store.loadEvents(runId)
  ]);
  const artifacts = await new ArtifactStore(store.runDir(runId)).list();
  return {
    run_id: runId,
    workflow_id: state.workflow_id,
    status: state.status,
    current_node_id: state.current_node_id,
    created_at: state.created_at,
    updated_at: state.updated_at,
    rework_count: state.rework_count ?? 0,
    rework_limit: state.rework_limit ?? 0,
    attempts: state.attempts.map((attempt) => ({
      node_id: attempt.node_id,
      attempt: attempt.attempt,
      activation: attempt.activation ?? 1,
      status: attempt.status
    })),
    node_results: nodeResults(events),
    artifacts,
    lifecycle: {
      tools: toolLifecycle(events),
      permissions: permissionLifecycle(events),
      processes: processLifecycle(events),
      failures: failures(events),
      model_response_count: events.filter((event) => event.type === "model_response_recorded").length,
      user_interaction_count: events.filter((event) => event.type === "node_waiting_user").length
    },
    omitted_payloads: [
      "model_stream_delta",
      "model_thinking_delta",
      "raw_tool_input",
      "raw_tool_result",
      "workflow_dialogue"
    ]
  };
}

function nodeResults(events: StoredEvent[]): DossierNodeResult[] {
  return events.flatMap((event) => {
    if (event.type !== "node_completed") return [];
    const parsed = nodeResultSchema.safeParse(event.result);
    if (!parsed.success) return [];
    return [{
      seq: event.seq,
      ts: event.ts,
      node_id: event.node_id,
      attempt: event.attempt ?? 1,
      activation: event.activation ?? 1,
      status: event.status,
      result: parsed.data
    }];
  });
}

function toolLifecycle(events: StoredEvent[]): DossierToolLifecycle[] {
  return events.flatMap<DossierToolLifecycle>((event) => {
    if (event.type === "tool_invoked") {
      return [{
        seq: event.seq,
        ts: event.ts,
        node_id: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        tool_call_id: event.tool_call_id,
        tool: event.tool,
        status: "invoked" as const
      }];
    }
    if (event.type === "tool_completed") {
      return [{
        seq: event.seq,
        ts: event.ts,
        node_id: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        tool_call_id: event.tool_call_id,
        tool: event.tool,
        status: "completed" as const
      }];
    }
    if (event.type !== "tool_failed") return [];
    return [{
      seq: event.seq,
      ts: event.ts,
      node_id: event.node_id,
      attempt: event.attempt,
      activation: event.activation,
      tool_call_id: event.tool_call_id,
      tool: event.tool,
      status: "failed" as const,
      error: bounded(event.error)
    }];
  });
}

function permissionLifecycle(events: StoredEvent[]): DossierPermissionLifecycle[] {
  const requested = new Map<string, { node_id: string; attempt: number; tool: string; rule?: string }>();
  return events.flatMap<DossierPermissionLifecycle>((event) => {
    if (event.type === "permission_requested") {
      requested.set(event.request_id, {
        node_id: event.node_id,
        attempt: event.attempt,
        tool: event.tool,
        rule: event.rule
      });
      return [{
        seq: event.seq,
        ts: event.ts,
        request_id: event.request_id,
        node_id: event.node_id,
        attempt: event.attempt,
        tool: event.tool,
        status: "requested" as const,
        rule: event.rule
      }];
    }
    if (event.type !== "permission_resolved") return [];
    const request = requested.get(event.request_id);
    return [{
      seq: event.seq,
      ts: event.ts,
      request_id: event.request_id,
      node_id: request?.node_id ?? event.node_id,
      attempt: request?.attempt ?? event.attempt,
      tool: request?.tool ?? "unknown",
      status: event.decision === "allow_once" ? "allowed" as const : "denied" as const,
      rule: request?.rule
    }];
  });
}

function processLifecycle(events: StoredEvent[]): DossierProcessLifecycle[] {
  return events.flatMap<DossierProcessLifecycle>((event) => {
    if (event.type === "managed_process_started") {
      return [{
        seq: event.seq,
        ts: event.ts,
        node_id: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        process_id: event.process_id,
        pid: event.pid,
        status: "started" as const,
        executable: event.executable
      }];
    }
    if (event.type === "managed_process_stopped") {
      return [{
        seq: event.seq,
        ts: event.ts,
        node_id: event.node_id,
        attempt: event.attempt,
        activation: event.activation,
        process_id: event.process_id,
        pid: event.pid,
        status: "stopped" as const,
        reason: event.reason,
        exit_code: event.exit_code
      }];
    }
    if (event.type !== "managed_process_cleanup_failed") return [];
    return [{
      seq: event.seq,
      ts: event.ts,
      node_id: event.node_id,
      attempt: event.attempt,
      activation: event.activation,
      process_id: event.process_id,
      pid: event.pid,
      status: "cleanup_failed" as const,
      reason: event.reason,
      error: bounded(event.error)
    }];
  });
}

function failures(events: StoredEvent[]): Array<{ seq: number; ts: string; scope: "tool" | "run" | "process"; error: string }> {
  return events.flatMap<{ seq: number; ts: string; scope: "tool" | "run" | "process"; error: string }>((event) => {
    if (event.type === "tool_failed") return [{ seq: event.seq, ts: event.ts, scope: "tool" as const, error: bounded(event.error) }];
    if (event.type === "run_failed") return [{ seq: event.seq, ts: event.ts, scope: "run" as const, error: bounded(event.detail ? `${event.error}\n${event.detail}` : event.error) }];
    if (event.type === "managed_process_cleanup_failed") return [{ seq: event.seq, ts: event.ts, scope: "process" as const, error: bounded(event.error) }];
    return [];
  });
}

function bounded(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

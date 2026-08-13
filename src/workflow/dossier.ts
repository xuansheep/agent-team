import type { StoredEvent } from "../harness/events.js";
import { ArtifactStore, type ArtifactRecord } from "../storage/artifacts.js";
import type { RunStore } from "../storage/runStore.js";
import { nodeResultSchema, type NodeResult } from "../team/nodeResult.js";
import type { WorkflowState } from "./state.js";
import type { ExecutionKind } from "../config/schema.js";

export type DossierNodeResult = {
  seq: number;
  ts: string;
  node_id: string;
  attempt: number;
  activation: number;
  status: "success" | "failure" | "completed" | "suspended" | "retrying";
  result: NodeResult;
  evidence?: DossierActivationEvidence;
};

export type DossierActivationEvidence = {
  status: "verified" | "unverified" | "stale" | "no_progress" | "failed" | "legacy_unverified";
  workspace_before_sha256?: string;
  workspace_after_sha256?: string;
  workspace_changed: boolean;
  changed_paths: string[];
  successful_tool_calls: number;
  failed_tool_calls: number;
  artifact_count: number;
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
  execution_kind?: ExecutionKind;
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
  latest_results?: DossierNodeResult[];
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
  const results = markStaleResults(nodeResults(events, artifacts));
  return {
    run_id: runId,
    workflow_id: state.workflow_id,
    execution_kind: state.execution_kind ?? "workflow",
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
    node_results: results,
    latest_results: latestNodeResults(results),
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

function nodeResults(events: StoredEvent[], artifacts: ArtifactRecord[]): DossierNodeResult[] {
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
      result: parsed.data,
      evidence: activationEvidence(events, artifacts, event.node_id, event.attempt ?? 1, event.activation ?? 1, event.status)
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


function markStaleResults(results: DossierNodeResult[]): DossierNodeResult[] {
  let previousWorkspaceHash: string | undefined;
  return results.map((result) => {
    const evidence = result.evidence;
    const stale = Boolean(previousWorkspaceHash && evidence?.workspace_before_sha256 && previousWorkspaceHash !== evidence.workspace_before_sha256);
    if (evidence?.workspace_after_sha256) previousWorkspaceHash = evidence.workspace_after_sha256;
    return stale && evidence ? { ...result, evidence: { ...evidence, status: "stale" as const } } : result;
  });
}

function latestNodeResults(results: DossierNodeResult[]): DossierNodeResult[] {
  const latest = new Map<string, DossierNodeResult>();
  for (const result of results) {
    const previous = latest.get(result.node_id);
    if (!previous || result.seq > previous.seq) latest.set(result.node_id, result);
  }
  return [...latest.values()].sort((left, right) => left.seq - right.seq);
}

function activationEvidence(
  events: StoredEvent[],
  artifacts: ArtifactRecord[],
  nodeId: string,
  attempt: number,
  activation: number,
  completionStatus: DossierNodeResult["status"]
): DossierActivationEvidence {
  const scoped = events.filter((event) =>
    "node_id" in event
    && event.node_id === nodeId
    && ("attempt" in event ? (event.attempt ?? 1) === attempt : true)
    && ("activation" in event ? (event.activation ?? 1) === activation : true)
  );
  const before = scoped.find((event): event is Extract<StoredEvent, { type: "workspace_snapshot_recorded" }> =>
    event.type === "workspace_snapshot_recorded" && event.phase === "before"
  );
  const after = [...scoped].reverse().find((event): event is Extract<StoredEvent, { type: "workspace_snapshot_recorded" }> =>
    event.type === "workspace_snapshot_recorded" && event.phase === "after"
  );
  const successful = scoped.filter((event) => event.type === "tool_completed").length;
  const failed = scoped.filter((event) => event.type === "tool_failed").length;
  const artifactCount = artifacts.filter((artifact) =>
    artifact.node_id === nodeId && !artifact.logical_name.startsWith("node-output-") && (artifact.attempt ?? 1) === attempt && (artifact.activation ?? 1) === activation
  ).length;
  const workspaceChanged = after?.changed === true;
  const hasFreshEvidence = successful > 0 || workspaceChanged || artifactCount > 0 || activation === 1;
  const status: DossierActivationEvidence["status"] = completionStatus === "failure"
    ? "failed"
    : !before || !after
      ? "legacy_unverified"
      : !hasFreshEvidence
        ? "no_progress"
        : failed > 0 && successful === 0
          ? "unverified"
          : "verified";
  return {
    status,
    workspace_before_sha256: before?.sha256,
    workspace_after_sha256: after?.sha256,
    workspace_changed: workspaceChanged,
    changed_paths: after?.changed_paths ?? [],
    successful_tool_calls: successful,
    failed_tool_calls: failed,
    artifact_count: artifactCount
  };
}

function compactNodeResult(item: DossierNodeResult): DossierNodeResult {
  return {
    ...item,
    result: {
      ...item.result,
      summary: bounded(item.result.summary, 2_000),
      document: bounded(item.result.document, 4_000),
      feedback: {
        defects: item.result.feedback.defects.slice(-50).map((value) => bounded(value, 500)),
        change_requests: item.result.feedback.change_requests.slice(-50).map((value) => bounded(value, 500))
      }
    }
  };
}

export function compactWorkflowRunDossier(dossier: WorkflowRunDossier): WorkflowRunDossier {
  const latestSeq = new Set((dossier.latest_results ?? latestNodeResults(dossier.node_results)).map((result) => result.seq));
  const latestTools = dossier.lifecycle.tools.filter((tool) =>
    (dossier.latest_results ?? latestNodeResults(dossier.node_results)).some((result) =>
      tool.node_id === result.node_id && (tool.attempt ?? 1) === result.attempt && (tool.activation ?? 1) === result.activation
    )
  );
  return {
    ...dossier,
    node_results: dossier.node_results.filter((result) => latestSeq.has(result.seq)).map(compactNodeResult),
    latest_results: (dossier.latest_results ?? latestNodeResults(dossier.node_results)).map(compactNodeResult),
    artifacts: dossier.artifacts.slice(-100),
    lifecycle: {
      ...dossier.lifecycle,
      tools: latestTools.slice(-100),
      permissions: dossier.lifecycle.permissions.slice(-50),
      processes: dossier.lifecycle.processes.slice(-50),
      failures: dossier.lifecycle.failures.slice(-50)
    }
  };
}

import type { NodeResult } from "./nodeResult.js";

export type HandoffReference = {
  node_id: string;
  summary: string;
  artifact_ids: string[];
};

export type HandoffContext = {
  from?: string;
  to: string;
  instruction: string;
  must_follow: string[];
  known_risks: string[];
  open_questions: string[];
  references: HandoffReference[];
  feedback?: NodeResult["feedback"];
  iteration: number;
  previous_handoff?: unknown;
};

export type PriorNodeResult = {
  node_id: string;
  attempt: number;
  activation: number;
  status: string;
  summary: string;
  deliverables: NodeResult["deliverables"];
  feedback: NodeResult["feedback"];
  handoff: NodeResult["handoff"];
};

type WorkflowDossierLike = {
  node_results?: Array<{
    seq: number;
    node_id: string;
    attempt: number;
    activation: number;
    status: string;
    result: NodeResult;
  }>;
};

export function buildHandoff(to: string, from: string | undefined, result: NodeResult, iteration: number): HandoffContext {
  return {
    from,
    to,
    instruction: result.handoff.instruction || result.summary,
    must_follow: result.handoff.must_follow,
    known_risks: result.handoff.known_risks,
    open_questions: result.handoff.open_questions,
    references: [{
      node_id: from ?? "input",
      summary: result.summary,
      artifact_ids: result.deliverables.map((item) => item.artifact_id)
    }],
    feedback: result.feedback,
    iteration
  };
}

export function workflowDossierContext(dossier: WorkflowDossierLike): {
  prior_results?: PriorNodeResult[];
  references?: HandoffReference[];
} {
  const latestByNode = new Map<string, NonNullable<WorkflowDossierLike["node_results"]>[number]>();
  for (const item of dossier.node_results ?? []) {
    const previous = latestByNode.get(item.node_id);
    if (!previous || item.seq > previous.seq) latestByNode.set(item.node_id, item);
  }
  const latest = [...latestByNode.values()].sort((left, right) => left.seq - right.seq);
  if (!latest.length) return {};

  const priorResults = latest.map((item) => ({
    node_id: item.node_id,
    attempt: item.attempt,
    activation: item.activation,
    status: item.status,
    summary: item.result.summary,
    deliverables: item.result.deliverables.map((deliverable) => ({ ...deliverable })),
    feedback: {
      defects: [...item.result.feedback.defects],
      change_requests: [...item.result.feedback.change_requests]
    },
    handoff: {
      instruction: item.result.handoff.instruction,
      must_follow: [...item.result.handoff.must_follow],
      known_risks: [...item.result.handoff.known_risks],
      open_questions: [...item.result.handoff.open_questions]
    }
  }));
  const references = priorResults
    .filter((item) => item.deliverables.length > 0)
    .map((item) => ({
      node_id: item.node_id,
      summary: item.summary,
      artifact_ids: item.deliverables.map((deliverable) => deliverable.artifact_id)
    }));
  return {
    prior_results: priorResults,
    ...(references.length ? { references } : {})
  };
}

export function compactHandoffLayer(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    previous_handoff: _previousHandoff,
    prior_dossier: priorDossier,
    ...layer
  } = value as Record<string, unknown>;
  const dossierContext = priorDossier && typeof priorDossier === "object"
    ? workflowDossierContext(priorDossier as WorkflowDossierLike)
    : {};
  const priorResults = Array.isArray(layer.prior_results)
    ? layer.prior_results
    : dossierContext.prior_results;
  const references = mergeReferences(layer.references, dossierContext.references);
  return {
    ...layer,
    ...(priorResults?.length ? { prior_results: priorResults } : {}),
    ...(references.length ? { references } : {})
  };
}

export function compactHandoffForModel(value: unknown): unknown {
  const current = compactHandoffLayer(value);
  if (!current || typeof current !== "object" || Array.isArray(current)) return current;
  const previousValue = (value as { previous_handoff?: unknown }).previous_handoff;
  if (previousValue === undefined) return current;
  const previous = compactHandoffLayer(previousValue);
  if (previous === undefined || sameCanonicalHandoff(current, previous)) return current;
  return { ...current, previous_handoff: previous };
}

export function buildResumeHandoff(previousHandoff: unknown, currentHandoff: HandoffContext): HandoffContext {
  if (previousHandoff === undefined || sameCanonicalHandoff(previousHandoff, currentHandoff)) return currentHandoff;
  return { ...currentHandoff, previous_handoff: compactHandoffLayer(previousHandoff) };
}

export function sameCanonicalHandoff(left: unknown, right: unknown): boolean {
  const leftLayer = canonicalHandoffLayer(left);
  const rightLayer = canonicalHandoffLayer(right);
  return leftLayer !== undefined && rightLayer !== undefined && stableJson(leftLayer) === stableJson(rightLayer);
}

function canonicalHandoffLayer(value: unknown): Record<string, unknown> | undefined {
  const layer = compactHandoffLayer(value);
  return layer && typeof layer === "object" && !Array.isArray(layer)
    ? layer as Record<string, unknown>
    : undefined;
}

function mergeReferences(left: unknown, right: HandoffReference[] | undefined): HandoffReference[] {
  const references = [
    ...(Array.isArray(left) ? left as HandoffReference[] : []),
    ...(right ?? [])
  ];
  const deduplicated = new Map<string, HandoffReference>();
  for (const reference of references) {
    const key = reference.artifact_ids.join("\u0000");
    if (!deduplicated.has(key)) deduplicated.set(key, {
      node_id: reference.node_id,
      summary: reference.summary,
      artifact_ids: [...reference.artifact_ids]
    });
  }
  return [...deduplicated.values()];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

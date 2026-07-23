import { NodeResult } from "./nodeResult.js";

export type HandoffContext = {
  from?: string;
  to: string;
  instruction: string;
  must_follow: string[];
  known_risks: string[];
  open_questions: string[];
  references: Array<{ node_id: string; summary: string; artifact_ids: string[] }>;
  feedback?: NodeResult["feedback"];
  iteration: number;
  previous_handoff?: unknown;
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

export function buildResumeHandoff(previousHandoff: unknown, currentHandoff: HandoffContext): HandoffContext {
  if (previousHandoff === undefined || sameCanonicalHandoff(previousHandoff, currentHandoff)) return currentHandoff;
  return { ...currentHandoff, previous_handoff: previousHandoff };
}

export function sameCanonicalHandoff(left: unknown, right: unknown): boolean {
  const leftLayer = canonicalHandoffLayer(left);
  const rightLayer = canonicalHandoffLayer(right);
  return leftLayer !== undefined && rightLayer !== undefined && stableJson(leftLayer) === stableJson(rightLayer);
}

function canonicalHandoffLayer(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { previous_handoff: _previousHandoff, ...layer } = value as Record<string, unknown>;
  return layer;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

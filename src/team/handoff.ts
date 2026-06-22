import { NodeResult } from "./nodeResult.js";

export type HandoffContext = {
  from?: string;
  to: string;
  instruction: string;
  references: Array<{ node_id: string; summary: string; artifact_ids: string[] }>;
  feedback?: NodeResult["feedback"];
  iteration: number;
};

export function buildHandoff(to: string, from: string | undefined, result: NodeResult, iteration: number): HandoffContext {
  return {
    from,
    to,
    instruction: result.handoff.instruction || result.summary,
    references: [{
      node_id: from ?? "input",
      summary: result.summary,
      artifact_ids: result.deliverables.map((item) => item.artifact_id)
    }],
    feedback: result.feedback,
    iteration
  };
}

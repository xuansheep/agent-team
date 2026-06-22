import { WorkflowConfig } from "../config/schema.js";

export function firstNodeId(workflow: WorkflowConfig): string {
  const targets = new Set(workflow.edges.map((edge) => edge.to));
  const first = workflow.nodes.find((node) => !targets.has(node.id));
  return first?.id ?? workflow.nodes[0].id;
}

export function nextNodeId(workflow: WorkflowConfig, from: string, status: "success" | "failure"): string | undefined {
  return workflow.edges.find((edge) => edge.from === from && edge.condition === status)?.to;
}

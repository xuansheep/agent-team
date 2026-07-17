import { WorkflowConfig } from "../config/schema.js";

export function firstNodeId(workflow: WorkflowConfig): string {
  const successEdges = workflow.edges.filter((edge) => edge.condition === "success");
  if (!successEdges.length) return workflow.nodes[0].id;

  const targets = new Set(successEdges.map((edge) => edge.to));
  const first = workflow.nodes.find((node) => !targets.has(node.id));
  return first?.id ?? workflow.nodes[0].id;
}

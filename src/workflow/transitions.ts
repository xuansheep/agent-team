import { WorkflowConfig } from "../config/schema.js";

export function firstNodeId(workflow: WorkflowConfig): string {
  const successEdges = workflow.edges.filter((edge) => edge.condition === "success");
  if (!successEdges.length) return workflow.nodes[0].id;

  const targets = new Set(successEdges.map((edge) => edge.to));
  const first = workflow.nodes.find((node) => !targets.has(node.id));
  return first?.id ?? workflow.nodes[0].id;
}

export function nextNodeId(workflow: WorkflowConfig, from: string, status: "success" | "failure"): string | undefined {
  const explicit = workflow.edges.find((edge) => edge.from === from && edge.condition === status)?.to;
  if (explicit) return explicit;

  const currentIndex = workflow.nodes.findIndex((node) => node.id === from);
  if (currentIndex === -1) return undefined;

  const usesOrderedRouting = !workflow.edges.some((edge) => edge.condition === "success");

  if (status === "success" && usesOrderedRouting) {
    return workflow.nodes[currentIndex + 1]?.id;
  }

  if (status === "failure" && usesOrderedRouting) {
    return workflow.nodes[currentIndex - 1]?.id;
  }

  return undefined;
}

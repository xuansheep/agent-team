import { AgentTeamConfig } from "./schema.js";

export function resolveConfig(config: AgentTeamConfig): AgentTeamConfig {
  for (const [workflowId, workflow] of Object.entries(config.workflows)) {
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));

    for (const node of workflow.nodes) {
      if (!config.roles[node.role]) {
        throw new Error(`Unknown role ${node.role} referenced by workflow ${workflowId} node ${node.id}`);
      }
      if (!config.providers[node.provider]) {
        throw new Error(`Unknown provider ${node.provider} referenced by workflow ${workflowId} node ${node.id}`);
      }
    }

    for (const edge of workflow.edges) {
      if (!nodeIds.has(edge.from)) {
        throw new Error(`Unknown edge source ${edge.from} in workflow ${workflowId}`);
      }
      if (!nodeIds.has(edge.to)) {
        throw new Error(`Unknown edge target ${edge.to} in workflow ${workflowId}`);
      }
    }
  }

  return config;
}

import { AgentTeamConfig } from "./schema.js";

export function resolveConfig(config: AgentTeamConfig): AgentTeamConfig {
  if (!config.dispatcher) {
    throw new Error("Missing required dispatcher configuration in ~/.einsteins/settings.json");
  }
  if (!config.providers[config.dispatcher.provider]) {
    throw new Error(`Unknown dispatcher provider ${config.dispatcher.provider}`);
  }

  for (const [workflowId, workflow] of Object.entries(config.workflows)) {
    const nodeIds = new Set(workflow.nodes.map((node) => node.id));
    if (nodeIds.size !== workflow.nodes.length) {
      throw new Error(`Duplicate node id in workflow ${workflowId}`);
    }

    for (const node of workflow.nodes) {
      if (!config.roles[node.role]) {
        throw new Error(`Unknown role ${node.role} referenced by workflow ${workflowId} node ${node.id}`);
      }
      if (!config.providers[node.provider]) {
        throw new Error(`Unknown provider ${node.provider} referenced by workflow ${workflowId} node ${node.id}`);
      }
    }

    const dispatcher = { ...config.dispatcher, ...workflow.dispatcher };
    if (!config.providers[dispatcher.provider]) {
      throw new Error(`Unknown dispatcher provider ${dispatcher.provider} referenced by workflow ${workflowId}`);
    }
    workflow.dispatcher = dispatcher;

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

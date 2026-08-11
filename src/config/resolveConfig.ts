import type { AgentTeamConfig, ExecutionKind, WorkflowConfig } from "./schema.js";

export function resolveConfig(config: AgentTeamConfig): AgentTeamConfig {
  if (!config.dispatcher) {
    throw new Error("Missing required dispatcher configuration in ~/.einsteins/settings.json");
  }
  if (!config.providers[config.dispatcher.provider]) {
    throw new Error(`Unknown dispatcher provider ${config.dispatcher.provider}`);
  }

  validateCollections(config, "workflow", config.workflows);
  validateCollections(config, "team", config.teams ?? {});
  return config;
}

function validateCollections(
  config: AgentTeamConfig,
  kind: ExecutionKind,
  collections: Record<string, WorkflowConfig>
): void {
  for (const [configId, collection] of Object.entries(collections)) {
    const nodeIds = new Set(collection.nodes.map((node) => node.id));
    if (nodeIds.size !== collection.nodes.length) {
      throw new Error(`Duplicate node id in ${kind} ${configId}`);
    }

    for (const node of collection.nodes) {
      if (!config.roles[node.role]) {
        throw new Error(`Unknown role ${node.role} referenced by ${kind} ${configId} node ${node.id}`);
      }
      if (!config.providers[node.provider]) {
        throw new Error(`Unknown provider ${node.provider} referenced by ${kind} ${configId} node ${node.id}`);
      }
    }

    const dispatcher = { ...config.dispatcher, ...collection.dispatcher };
    if (!config.providers[dispatcher.provider]) {
      throw new Error(`Unknown dispatcher provider ${dispatcher.provider} referenced by ${kind} ${configId}`);
    }
    collection.dispatcher = dispatcher;

    for (const edge of collection.edges) {
      if (!nodeIds.has(edge.from)) {
        throw new Error(`Unknown edge source ${edge.from} in ${kind} ${configId}`);
      }
      if (!nodeIds.has(edge.to)) {
        throw new Error(`Unknown edge target ${edge.to} in ${kind} ${configId}`);
      }
    }
  }
}

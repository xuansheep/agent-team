import { Box, Text } from "../ink.js";
import { TuiNodeState, TuiWorkflowNodeState } from "../state.js";

export function NodeStatusList({
  nodes,
  workflowNodes,
  currentNodeId
}: {
  nodes: TuiNodeState[];
  workflowNodes?: TuiWorkflowNodeState[];
  currentNodeId?: string;
}) {
  const rows = workflowNodes?.length
    ? workflowNodes.map((node) => ({ id: node.id, state: latestNodeState(nodes, node.id) }))
    : nodes.map((node) => ({ id: node.nodeId, state: node }));

  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row) => {
        const active = row.id === currentNodeId;
        const text = row.state ? `${row.id} #${row.state.attempt}.${row.state.activation ?? 1} ${row.state.status}` : `${row.id} pending`;
        return (
          <Text key={row.id} color={active ? "cyan" : undefined} bold={active}>
            {text}
          </Text>
        );
      })}
    </Box>
  );
}

function latestNodeState(nodes: TuiNodeState[], nodeId: string): TuiNodeState | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.nodeId === nodeId) return node;
  }
  return undefined;
}

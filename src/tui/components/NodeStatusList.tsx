import React from "react";
import { Box, Text } from "ink";
import { TuiNodeState } from "../state.js";

export function NodeStatusList({ nodes }: { nodes: TuiNodeState[] }) {
  return (
    <Box flexDirection="column">
      {nodes.map((node) => (
        <Text key={`${node.nodeId}:${node.attempt}`}>
          {node.nodeId} #{node.attempt} {node.status}
        </Text>
      ))}
    </Box>
  );
}

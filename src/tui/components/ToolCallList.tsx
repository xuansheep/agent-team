import React from "react";
import { Box, Text } from "../ink.js";
import { TuiToolState } from "../state.js";

export function ToolCallList({ tools }: { tools: TuiToolState[] }) {
  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Text key={tool.toolCallId}>
          {tool.tool} {tool.status} {tool.expanded ? JSON.stringify(tool.result ?? tool.error ?? tool.input).slice(0, 300) : ""}
        </Text>
      ))}
    </Box>
  );
}

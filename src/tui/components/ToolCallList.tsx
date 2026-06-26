import React from "react";
import { Box, Text } from "../ink.js";
import { TuiToolState } from "../state.js";
import { getToolInputDetail, getToolResultDetail } from "../toolDisplay.js";

export function ToolCallList({ tools }: { tools: TuiToolState[] }) {
  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Text key={tool.toolCallId}>
          {tool.tool} {tool.status} {tool.expanded ? ` ${expandedToolDetail(tool)}` : ""}
        </Text>
      ))}
    </Box>
  );
}

function expandedToolDetail(tool: TuiToolState): string {
  if (tool.status === "completed") return getToolResultDetail(tool.result);
  if (tool.status === "failed") return `错误：${tool.error ?? "unknown error"}`;
  return getToolInputDetail(tool.tool, tool.input);
}

import React from "react";
import { Box, Text } from "../ink.js";

export function Header({ cwd, workflowId, runId }: { cwd: string; workflowId?: string; runId?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>agent-team</Text>
      <Text dimColor>{cwd}</Text>
      <Text>
        workflow {workflowId ?? "unselected"}
        {runId ? ` | run ${runId}` : ""}
      </Text>
    </Box>
  );
}

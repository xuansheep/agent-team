import React from "react";
import { Box, Text } from "../../ink.js";

export function PromptInputFooter({ workflowId, isLoading }: { workflowId?: string; isLoading: boolean }) {
  return (
    <Box>
      <Text dimColor>
        workflow {workflowId ?? "unselected"} | Enter submit | Alt+Enter newline | Esc cancel | Ctrl+C stop
        {isLoading ? " | running" : ""}
      </Text>
    </Box>
  );
}

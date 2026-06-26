import React from "react";
import { Box, Text } from "../../ink.js";

export function PromptInputFooter({ workflowId, isLoading, hasSelection }: { workflowId?: string; isLoading: boolean; hasSelection?: boolean }) {
  return (
    <Box>
      <Text dimColor>
        workflow {workflowId ?? "unselected"} | Enter submit | Alt+Enter newline | Ctrl+O transcript | Esc cancel | Ctrl+C {hasSelection ? "copy" : "stop"}
        {isLoading ? " | running" : ""}
      </Text>
    </Box>
  );
}

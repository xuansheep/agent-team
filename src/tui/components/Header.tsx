import type { ExecutionKind } from "../../config/schema.js";
import { Box, Text } from "../ink.js";

export function Header({ workflowId, executionKind = "workflow", sessionId }: { workflowId?: string; executionKind?: ExecutionKind; sessionId?: string }) {
  return (
    <Box flexDirection="column">
      <Text>
        {executionKind} {workflowId ?? "unselected"}
        {sessionId ? ` | session ${sessionId}` : ""}
      </Text>
    </Box>
  );
}

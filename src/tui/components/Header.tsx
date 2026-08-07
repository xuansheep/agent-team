import { Box, Text } from "../ink.js";

export function Header({ workflowId, sessionId }: { workflowId?: string; sessionId?: string }) {
  return (
    <Box flexDirection="column">
      <Text>
        workflow {workflowId ?? "unselected"}
        {sessionId ? ` | session ${sessionId}` : ""}
      </Text>
    </Box>
  );
}

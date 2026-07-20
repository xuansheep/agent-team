import { Box, Text } from "../ink.js";

export function Header({ cwd, workflowId, sessionId }: { cwd: string; workflowId?: string; sessionId?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>agent-team</Text>
      <Text dimColor>{cwd}</Text>
      <Text>
        workflow {workflowId ?? "unselected"}
        {sessionId ? ` | session ${sessionId}` : ""}
      </Text>
    </Box>
  );
}

import { Box, Text } from "../ink.js";

export function ResultPanel({ mode, error }: { mode: string; error?: string; runId?: string }) {
  if (["paused", "completed", "interrupted", "failed"].includes(mode)) return null;
  if (!error) return null;

  return (
    <Box flexDirection="column">
      <Text color="red">{error}</Text>
    </Box>
  );
}
import React from "react";
import { Box, Text } from "ink";

export function ResultPanel({ mode, error, runId }: { mode: string; error?: string; runId?: string }) {
  if (!["completed", "failed", "interrupted"].includes(mode)) return null;
  return (
    <Box flexDirection="column">
      <Text>{mode}</Text>
      {error ? <Text color="red">{error}</Text> : null}
      {runId ? <Text dimColor>run {runId}</Text> : null}
    </Box>
  );
}

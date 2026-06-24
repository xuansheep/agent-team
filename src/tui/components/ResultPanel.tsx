import React from "react";
import { Box, Text } from "../ink.js";

export function ResultPanel({ mode, error, runId }: { mode: string; error?: string; runId?: string }) {
  const hasResultStatus = ["paused", "completed", "failed", "interrupted"].includes(mode);
  if (!hasResultStatus && !error) return null;
  const label = mode === "paused" ? "paused" : mode;
  return (
    <Box flexDirection="column">
      {hasResultStatus ? <Text>{label}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {runId ? <Text dimColor>session {runId}</Text> : null}
    </Box>
  );
}

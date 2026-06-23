import React from "react";
import { Box, Text, useStdout } from "../ink.js";
import { TuiPlanReviewState } from "../state.js";

export function PlanReviewPrompt({
  review,
  offset = 0,
  visibleRows
}: {
  review?: TuiPlanReviewState;
  offset?: number;
  visibleRows?: number;
}) {
  const { stdout } = useStdout();
  if (!review) return null;
  const rows = visibleRows ?? Math.max(6, Math.min(15, Math.floor(((stdout.rows && stdout.rows > 0 ? stdout.rows : 24) - 10) / 2)));
  const lines = review.document.split(/\r?\n/);
  const maxOffset = Math.max(0, lines.length - rows);
  const start = Math.max(0, Math.min(offset, maxOffset));
  const visible = lines.slice(start, start + rows);
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexShrink={0}>
      <Text color="yellow">Plan Review</Text>
      <Text dimColor>{review.nodeId} #{review.attempt} | scroll with mouse wheel over this window</Text>
      <Box flexDirection="column">
        {visible.map((line, index) => <Text key={`${start}:${index}`}>{line || " "}</Text>)}
      </Box>
      <Text dimColor>{lines.length ? `${Math.min(start + 1, lines.length)}-${Math.min(start + rows, lines.length)} / ${lines.length}` : "0 / 0"}</Text>
    </Box>
  );
}

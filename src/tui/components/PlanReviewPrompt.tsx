import React from "react";
import { Box, Text } from "../ink.js";
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
  if (!review) return null;
  const rows = visibleRows;
  const lines = review.document.split(/\r?\n/);
  const maxOffset = rows === undefined ? 0 : Math.max(0, lines.length - rows);
  const start = rows === undefined ? 0 : Math.max(0, Math.min(offset, maxOffset));
  const visible = rows === undefined ? lines : lines.slice(start, start + rows);
  const end = rows === undefined ? lines.length : Math.min(start + rows, lines.length);
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexShrink={0}>
      <Text color="yellow">Plan Review</Text>
      <Text dimColor>{review.nodeId} #{review.attempt} | scroll main window with mouse wheel or PageUp/PageDown</Text>
      <Box flexDirection="column">
        {visible.map((line, index) => <Text key={`${start}:${index}`}>{line || " "}</Text>)}
      </Box>
      <Text dimColor>{lines.length ? `${Math.min(start + 1, lines.length)}-${end} / ${lines.length}` : "0 / 0"}</Text>
    </Box>
  );
}

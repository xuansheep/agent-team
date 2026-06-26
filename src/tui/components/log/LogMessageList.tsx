import React from "react";
import { Box, Text } from "../../ink.js";
import type { TuiLogMessage } from "../../logTypes.js";
import { LogMessageRow } from "./LogMessageRow.js";

export function LogMessageList({
  items,
  currentNodeId,
  currentAttempt,
  detailMode,
  offset = 0,
  visibleRows
}: {
  items: TuiLogMessage[];
  currentNodeId?: string;
  currentAttempt?: number;
  detailMode: boolean;
  offset?: number;
  visibleRows?: number;
}) {
  const filtered = currentNodeId ? items.filter((item) => isVisible(item, currentNodeId, currentAttempt)) : items;
  const maxOffset = visibleRows === undefined ? 0 : Math.max(0, filtered.length - visibleRows);
  const start = visibleRows === undefined ? 0 : Math.min(offset, maxOffset);
  const visible = visibleRows === undefined ? filtered : filtered.slice(start, start + visibleRows);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{detailMode ? "Logs detailed (ctrl+o to collapse)" : "Logs compact (ctrl+o to expand)"}</Text>
      {visible.map((item) => (
        <LogMessageRow key={item.id} item={item} detailMode={detailMode} />
      ))}
    </Box>
  );
}

function isVisible(item: TuiLogMessage, currentNodeId: string | undefined, currentAttempt: number | undefined): boolean {
  if (item.kind === "user") return true;
  if (!item.nodeId) return true;
  if (!currentNodeId || item.nodeId !== currentNodeId) return false;
  return currentAttempt === undefined || item.attempt === undefined || item.attempt === currentAttempt;
}

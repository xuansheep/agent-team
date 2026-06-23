import React from "react";
import { Box, Text } from "ink";
import { TuiConversationItem } from "../state.js";

export function RunLogPanel({
  items,
  currentNodeId,
  currentAttempt,
  detailMode,
  offset = 0,
  visibleRows = 14
}: {
  items: TuiConversationItem[];
  currentNodeId?: string;
  currentAttempt?: number;
  detailMode: boolean;
  offset?: number;
  visibleRows?: number;
}) {
  const filtered = items.filter((item) => isVisible(item, currentNodeId, currentAttempt));
  const maxOffset = Math.max(0, filtered.length - visibleRows);
  const start = Math.min(offset, maxOffset);
  const visible = filtered.slice(start, start + visibleRows);

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      <Text dimColor>{detailMode ? "Logs detailed | Ctrl+O compact" : "Logs compact | Ctrl+O details"}</Text>
      {visible.map((item, index) => (
        <Box key={`${index}:${item.kind}:${item.nodeId ?? "run"}:${item.attempt ?? 0}`} flexDirection="column">
          <Text color={labelColor(item.kind)}>{label(item)}</Text>
          <Text>{item.text.slice(-1200)}</Text>
          {detailMode && item.detailText ? <Text dimColor>{item.detailText.slice(-1200)}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function isVisible(item: TuiConversationItem, currentNodeId: string | undefined, currentAttempt: number | undefined): boolean {
  if (item.kind === "user") return true;
  if (!item.nodeId) return true;
  if (!currentNodeId || item.nodeId !== currentNodeId) return false;
  return currentAttempt === undefined || item.attempt === undefined || item.attempt === currentAttempt;
}

function label(item: TuiConversationItem): string {
  if (item.kind === "user") return "User";
  if (item.kind === "assistant") return item.nodeId && item.attempt ? `Assistant ${item.nodeId} #${item.attempt}` : "Assistant";
  return item.nodeId && item.attempt ? `Status ${item.nodeId} #${item.attempt}` : "Status";
}

function labelColor(kind: TuiConversationItem["kind"]): "cyan" | "green" | "yellow" {
  if (kind === "user") return "cyan";
  if (kind === "assistant") return "green";
  return "yellow";
}

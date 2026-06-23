import React from "react";
import { Box, Text } from "ink";
import { TuiConversationItem } from "../state.js";

export function RunConversationPanel({
  items,
  currentNodeId,
  currentAttempt
}: {
  items: TuiConversationItem[];
  currentNodeId?: string;
  currentAttempt?: number;
}) {
  const visible = items.filter((item) => isVisible(item, currentNodeId, currentAttempt)).slice(-12);
  if (!visible.length) return null;

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {visible.map((item, index) => (
        <Box key={`${index}:${item.kind}:${item.nodeId ?? "run"}:${item.attempt ?? 0}`} flexDirection="column">
          <Text dimColor>{label(item)}</Text>
          <Text>{item.text.slice(-1200)}</Text>
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
  if (item.kind === "user") return "user";
  if (item.kind === "assistant") return item.nodeId && item.attempt ? `${item.nodeId} #${item.attempt} assistant` : "assistant";
  return item.nodeId && item.attempt ? `${item.nodeId} #${item.attempt} status` : "status";
}

import { Box, Text } from "../ink.js";
import { visibleAssistantTextBeforeNodeResult } from "../../team/nodeResult.js";
import { TuiConversationItem } from "../state.js";

export function RunConversationPanel({
  items
}: {
  items: TuiConversationItem[];
  currentNodeId?: string;
  currentAttempt?: number;
}) {
  const visible = items.map(renderableConversationItem).filter((item) => item.text.length > 0).slice(-12);
  if (!visible.length) return null;

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {visible.map((item, index) => (
        <ConversationRow key={`${index}:${item.kind}:${item.nodeId ?? "run"}:${item.attempt ?? 0}`} item={item} />
      ))}
    </Box>
  );
}

function ConversationRow({ item }: { item: TuiConversationItem }) {
  if (item.kind === "assistant") {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box minWidth={2}>
          <Text color="green">●</Text>
        </Box>
        <Text wrap="wrap">{item.text.slice(-1200)}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{label(item)}</Text>
      <Text>{item.text.slice(-1200)}</Text>
    </Box>
  );
}

function renderableConversationItem(item: TuiConversationItem): TuiConversationItem {
  if (item.kind !== "assistant") return item;
  return { ...item, text: visibleAssistantTextBeforeNodeResult(item.text).trim() };
}

function label(item: TuiConversationItem): string {
  if (item.kind === "user") return "user";
  return item.nodeId && item.attempt ? `${item.nodeId} #${item.attempt} status` : "status";
}

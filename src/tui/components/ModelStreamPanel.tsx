import { Box, Text } from "../ink.js";
import { visibleAssistantTextBeforeNodeResult } from "../../team/nodeResult.js";
import { TuiModelStreamState } from "../state.js";

export function ModelStreamPanel({ streams }: { streams: TuiModelStreamState[] }) {
  const visible = streams
    .map((stream) => ({ ...stream, text: visibleAssistantTextBeforeNodeResult(stream.text).trim() }))
    .filter((stream) => stream.text.length > 0)
    .slice(-3);

  if (!visible.length) return null;

  return (
    <Box flexDirection="column">
      {visible.map((stream) => (
        <Box key={`${stream.nodeId}:${stream.attempt}`} flexDirection="row" marginTop={1}>
          <Box minWidth={2}>
            <Text color="green">●</Text>
          </Box>
          <Text wrap="wrap">{stream.text.slice(-1000)}</Text>
        </Box>
      ))}
    </Box>
  );
}

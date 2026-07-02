import { Box, Text } from "../../ink.js";

export function PromptInputQueuedCommands({ queued }: { queued: string[] }) {
  if (queued.length === 0) return null;
  return (
    <Box flexDirection="column">
      {queued.map((item, index) => (
        <Text key={`${index}:${item}`} color="yellow">
          queued {index + 1}: {item}
        </Text>
      ))}
    </Box>
  );
}

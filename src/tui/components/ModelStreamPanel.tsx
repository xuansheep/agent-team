import React from "react";
import { Box, Text } from "../ink.js";
import { TuiModelStreamState } from "../state.js";

export function ModelStreamPanel({ streams }: { streams: TuiModelStreamState[] }) {
  if (!streams.length) return null;

  return (
    <Box flexDirection="column">
      {streams.slice(-3).map((stream) => (
        <Box key={`${stream.nodeId}:${stream.attempt}`} flexDirection="column">
          <Text dimColor>{stream.nodeId} #{stream.attempt} streaming</Text>
          <Text>{stream.text.slice(-1000)}</Text>
        </Box>
      ))}
    </Box>
  );
}

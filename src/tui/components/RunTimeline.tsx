import React from "react";
import { Box, Text } from "../ink.js";

export function RunTimeline({ items }: { items: string[] }) {
  return (
    <Box flexDirection="column">
      {items.slice(-8).map((item, index) => (
        <Text key={`${index}:${item}`} dimColor>
          {item}
        </Text>
      ))}
    </Box>
  );
}

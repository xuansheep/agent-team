import React from "react";
import { Box, Text } from "ink";

export function PromptInputSuggestions({ suggestions }: { suggestions: string[] }) {
  if (suggestions.length === 0) return null;
  return (
    <Box>
      <Text dimColor>{suggestions.join("  ")}</Text>
    </Box>
  );
}

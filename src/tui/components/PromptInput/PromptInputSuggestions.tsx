import React from "react";
import { Box, Text } from "ink";
import { SlashCommandSuggestion } from "../../commandCompletion.js";

export function PromptInputSuggestions({ suggestions, selectedIndex }: { suggestions: SlashCommandSuggestion[]; selectedIndex: number }) {
  if (suggestions.length === 0) return null;
  const visible = suggestions.slice(0, 6);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((suggestion, index) => (
        <Text key={suggestion.value} color={index === selectedIndex ? "cyan" : undefined} dimColor={index !== selectedIndex}>
          {index === selectedIndex ? ">" : " "} {suggestion.label} <Text dimColor>{suggestion.description}</Text>
        </Text>
      ))}
    </Box>
  );
}

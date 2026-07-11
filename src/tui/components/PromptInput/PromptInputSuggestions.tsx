import { Box, Text } from "../../ink.js";
import { SlashCommandSuggestion } from "../../commandCompletion.js";

const MAX_VISIBLE_SUGGESTIONS = 6;

export function PromptInputSuggestions({ suggestions, selectedIndex }: { suggestions: SlashCommandSuggestion[]; selectedIndex: number }) {
  if (suggestions.length === 0) return null;
  const startIndex = Math.max(0, Math.min(
    selectedIndex - Math.floor(MAX_VISIBLE_SUGGESTIONS / 2),
    suggestions.length - MAX_VISIBLE_SUGGESTIONS
  ));
  const visible = suggestions.slice(startIndex, startIndex + MAX_VISIBLE_SUGGESTIONS);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((suggestion, index) => {
        const isSelected = startIndex + index === selectedIndex;
        return (
          <Text key={suggestion.value} color={isSelected ? "cyan" : undefined} dimColor={!isSelected}>
            {isSelected ? ">" : " "} {suggestion.label} <Text dimColor>{suggestion.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

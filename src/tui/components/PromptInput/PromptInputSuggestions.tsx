import { Box, Text, useStdout } from "../../ink.js";
import { stringWidth } from "../../../ink/stringWidth.js";
import wrapText from "../../../ink/wrap-text.js";
import { SlashCommandSuggestion } from "../../commandCompletion.js";

const MAX_VISIBLE_SUGGESTIONS = 6;
const SUGGESTION_PADDING_LEFT = 1;
const MARKER_COLUMNS = 2;
const DESCRIPTION_GAP_COLUMNS = 2;
const MAX_DESCRIPTION_START_RATIO = 0.7;

export function PromptInputSuggestions({ suggestions, selectedIndex }: { suggestions: SlashCommandSuggestion[]; selectedIndex: number }) {
  const { stdout } = useStdout();
  const terminalColumns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  if (suggestions.length === 0) return null;
  const startIndex = Math.max(0, Math.min(
    selectedIndex - Math.floor(MAX_VISIBLE_SUGGESTIONS / 2),
    suggestions.length - MAX_VISIBLE_SUGGESTIONS
  ));
  const visible = suggestions.slice(startIndex, startIndex + MAX_VISIBLE_SUGGESTIONS);
  const contentColumns = Math.max(1, terminalColumns - SUGGESTION_PADDING_LEFT);
  const widestLabelColumns = Math.max(...suggestions.map((suggestion) => stringWidth(suggestion.label)));
  const maxDescriptionStartColumns = Math.floor(contentColumns * MAX_DESCRIPTION_START_RATIO);
  const labelColumns = Math.min(
    widestLabelColumns,
    Math.max(1, maxDescriptionStartColumns - MARKER_COLUMNS - DESCRIPTION_GAP_COLUMNS)
  );
  const descriptionColumns = Math.max(
    0,
    contentColumns - MARKER_COLUMNS - labelColumns - DESCRIPTION_GAP_COLUMNS
  );
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((suggestion, index) => {
        const isSelected = startIndex + index === selectedIndex;
        const label = wrapText(suggestion.label, labelColumns, "truncate-end");
        const labelPadding = " ".repeat(Math.max(0, labelColumns - stringWidth(label)));
        const prefix = `${isSelected ? ">" : " "} ${label}${labelPadding}${" ".repeat(DESCRIPTION_GAP_COLUMNS)}`;
        const description = suggestion.description.replace(/\s+/g, " ").trim();
        return (
          <Text key={suggestion.value} color={isSelected ? "cyan" : undefined} dimColor={!isSelected}>
            {prefix}<Text dimColor>{wrapText(description, descriptionColumns, "truncate-end")}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

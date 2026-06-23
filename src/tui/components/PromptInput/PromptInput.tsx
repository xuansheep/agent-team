import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { commandArgumentHint, slashCommandSuggestions } from "../../commandCompletion.js";
import { PromptBuffer, PromptInputEvent, PromptInputMode } from "./types.js";
import { createPromptBuffer } from "./usePromptBuffer.js";
import { createHistory } from "./usePromptHistory.js";
import { usePromptKeybindings } from "./usePromptKeybindings.js";
import { PromptInputFooter } from "./PromptInputFooter.js";
import { PromptInputHistory } from "./PromptInputHistory.js";
import { PromptInputModeIndicator } from "./PromptInputModeIndicator.js";
import { PromptInputQueuedCommands } from "./PromptInputQueuedCommands.js";
import { PromptInputStashNotice } from "./PromptInputStashNotice.js";
import { PromptInputSuggestions } from "./PromptInputSuggestions.js";
import { PromptInputCursor } from "./PromptInputCursor.js";

export function PromptInput(props: {
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  isLoading: boolean;
  stash?: string;
  onEvent: (event: PromptInputEvent) => void;
  promptTop?: number;
}) {
  const { stdout } = useStdout();
  const terminalRows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  const [buffer, setBuffer] = useState(createPromptBuffer());
  const [history, setHistory] = useState(createHistory());
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dismissedCompletionFor, setDismissedCompletionFor] = useState<string>();
  const rawSuggestions = useMemo(() => slashCommandSuggestions(buffer.text, { workflows: props.workflows }), [buffer.text, props.workflows]);
  const suggestions = dismissedCompletionFor === buffer.text ? [] : rawSuggestions;
  const argumentHint = commandArgumentHint(buffer.text);
  const visibleSuggestionCount = Math.min(suggestions.length, 6);

  useEffect(() => {
    if (dismissedCompletionFor !== undefined && dismissedCompletionFor !== buffer.text) setDismissedCompletionFor(undefined);
    if (rawSuggestions.length === 0) {
      setSelectedSuggestion(0);
      return;
    }
    if (selectedSuggestion >= 0) setSelectedSuggestion((current) => Math.max(0, Math.min(current, rawSuggestions.length - 1)));
  }, [buffer.text, dismissedCompletionFor, rawSuggestions.length, selectedSuggestion]);

  const updateSelectedSuggestion = (index: number) => {
    if (index < 0) {
      setDismissedCompletionFor(buffer.text);
      setSelectedSuggestion(0);
      return;
    }
    setSelectedSuggestion(index);
  };

  usePromptKeybindings({
    mode: props.mode,
    buffer,
    history,
    isLoading: props.isLoading,
    suggestions,
    selectedSuggestion,
    onSelectedSuggestion: updateSelectedSuggestion,
    onBuffer: setBuffer,
    onHistory: setHistory,
    onEvent: props.onEvent
  });

  const hasStash = Boolean(props.stash);

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box>
        <PromptInputModeIndicator mode={props.mode} />
        <Text> &gt; </Text>
        <PromptBufferView buffer={buffer} placeholder="Type a request or /help" />
        {argumentHint ? <Text dimColor> {argumentHint}</Text> : null}
      </Box>
      <PromptInputCursor
        terminalRows={terminalRows}
        promptTop={props.promptTop}
        mode={props.mode}
        text={buffer.text}
        cursor={buffer.cursor}
        suggestions={visibleSuggestionCount}
        queued={props.queued.length}
        hasStash={hasStash}
        history={history.entries.length}
      />
      <PromptInputSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
      <PromptInputQueuedCommands queued={props.queued} />
      <PromptInputStashNotice hasStash={hasStash} />
      <PromptInputHistory count={history.entries.length} />
      <PromptInputFooter workflowId={props.workflowId} isLoading={props.isLoading} />
    </Box>
  );
}

function PromptBufferView({ buffer, placeholder }: { buffer: PromptBuffer; placeholder: string }) {
  if (!buffer.text) {
    return <Text dimColor>{placeholder}</Text>;
  }

  return <Text>{buffer.text}</Text>;
}

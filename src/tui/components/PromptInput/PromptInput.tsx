import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { PromptInputEvent, PromptInputMode } from "./types.js";
import { createPromptBuffer } from "./usePromptBuffer.js";
import { createHistory } from "./usePromptHistory.js";
import { slashCommandSuggestions } from "./usePromptSuggestions.js";
import { usePromptKeybindings } from "./usePromptKeybindings.js";
import { PromptInputFooter } from "./PromptInputFooter.js";
import { PromptInputHistory } from "./PromptInputHistory.js";
import { PromptInputModeIndicator } from "./PromptInputModeIndicator.js";
import { PromptInputQueuedCommands } from "./PromptInputQueuedCommands.js";
import { PromptInputStashNotice } from "./PromptInputStashNotice.js";
import { PromptInputSuggestions } from "./PromptInputSuggestions.js";

export function PromptInput(props: {
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  isLoading: boolean;
  stash?: string;
  onEvent: (event: PromptInputEvent) => void;
}) {
  const [buffer, setBuffer] = useState(createPromptBuffer());
  const [history, setHistory] = useState(createHistory());
  usePromptKeybindings({
    mode: props.mode,
    buffer,
    history,
    isLoading: props.isLoading,
    onBuffer: setBuffer,
    onHistory: setHistory,
    onEvent: props.onEvent
  });
  const suggestions = useMemo(() => slashCommandSuggestions(buffer.text, props.workflows), [buffer.text, props.workflows]);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Box>
        <PromptInputModeIndicator mode={props.mode} />
        <Text> {buffer.text || "Type a request or /help"}</Text>
      </Box>
      <PromptInputSuggestions suggestions={suggestions} />
      <PromptInputQueuedCommands queued={props.queued} />
      <PromptInputStashNotice hasStash={Boolean(props.stash)} />
      <PromptInputHistory count={history.entries.length} />
      <PromptInputFooter workflowId={props.workflowId} isLoading={props.isLoading} />
    </Box>
  );
}

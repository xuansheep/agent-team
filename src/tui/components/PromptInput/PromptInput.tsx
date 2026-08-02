import { useEffect, useMemo, useState } from "react";
import { useTerminalFocus } from "../../../ink/hooks/use-terminal-focus.js";
import { Box, Text, useDeclaredCursor, useStdout } from "../../ink.js";
import { Cursor } from "../../../utils/Cursor.js";
import { commandArgumentHint, slashCommandSuggestions } from "../../commandCompletion.js";
import type { PermissionMode } from "../../../permissions/PermissionMode.js";
import type { PromptHistoryStore } from "../../../storage/promptHistoryStore.js";
import { PromptInputEvent, PromptInputImageAttachment, PromptInputMode } from "./types.js";
import { createPromptBuffer } from "./usePromptBuffer.js";
import { createHistory } from "./usePromptHistory.js";
import { usePromptKeybindings } from "./usePromptKeybindings.js";

import { PromptInputQueuedCommands } from "./PromptInputQueuedCommands.js";
import { PromptInputStashNotice } from "./PromptInputStashNotice.js";
import { PromptInputSuggestions } from "./PromptInputSuggestions.js";
import { applyPromptNativeCursor } from "./PromptInputCursor.js";

export function PromptInput(props: {
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  skills?: Array<{ name: string; description?: string; argumentHint?: string }>;
  isLoading: boolean;
  permissionMode?: PermissionMode;
  historyStore?: PromptHistoryStore;
  inputBlocked?: boolean;
  textInputBlocked?: boolean;
  hasSelection?: boolean;
  stash?: string;
  editText?: (text: string) => Promise<{ content: string | null; error?: string }> | { content: string | null; error?: string };
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: PromptInputImageAttachment[] }>;
  onEvent: (event: PromptInputEvent) => void;

  onTextChange?: (text: string) => void;
}) {
  const { stdout } = useStdout();
  const terminalFocus = useTerminalFocus();
  const terminalColumns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  const terminalRows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  const [buffer, setBuffer] = useState(createPromptBuffer());
  const [history, setHistory] = useState(() => createHistory(props.historyStore?.entries));
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [imageAttachments, setImageAttachments] = useState<PromptInputImageAttachment[]>([]);
  const [dismissedCompletionFor, setDismissedCompletionFor] = useState<string>();
  const rawSuggestions = useMemo(() => slashCommandSuggestions(buffer.text, { workflows: props.workflows, skills: props.skills }), [buffer.text, props.workflows, props.skills]);
  const suggestions = history.index !== undefined || dismissedCompletionFor === buffer.text ? [] : rawSuggestions;
  const argumentHint = commandArgumentHint(buffer.text);

  useEffect(() => {
    props.onTextChange?.(buffer.text);
  }, [buffer.text, props.onTextChange]);

  useEffect(() => {
    return applyPromptNativeCursor(stdout);
  }, [stdout]);

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

  const handleEvent = (event: PromptInputEvent) => {
    if (event.type === "submit" || event.type === "queue") setImageAttachments([]);
    props.onEvent(event);
  };

  usePromptKeybindings({
    mode: props.mode,
    buffer,
    history,
    isLoading: props.isLoading,
    isActive: !props.inputBlocked,
    textInputBlocked: props.textInputBlocked,
    imageAttachments,
    skillNames: props.skills?.map((skill) => skill.name) ?? [],
    suggestions,
    selectedSuggestion,
    onSelectedSuggestion: updateSelectedSuggestion,
    onBuffer: setBuffer,
    onHistory: setHistory,
    onRecordHistory: props.historyStore?.add,
    onEvent: handleEvent,
    onImagePaste: (image) => setImageAttachments((current) => [...current, image]),
    resolveImagePaste: props.resolveImagePaste,
    editText: props.editText
  });

  const hasStash = Boolean(props.stash);
  const inputColumns = Math.max(1, terminalColumns - 2);
  const maxVisibleLines = Math.max(3, Math.floor(terminalRows / 2) - 5);
  const promptPlaceholder = "Type a request or /help";
  // Cursor.fromText reserves one display column for a rendered block cursor.
  // This input uses the terminal's native cursor instead, so compensate for
  // that reservation to keep its wrapping model aligned with the Ink box.
  const cursor = Cursor.fromText(buffer.text, inputColumns + 1, buffer.cursor);
  const cursorPosition = cursor.getPosition();
  const viewportStartLine = cursor.getViewportStartLine(maxVisibleLines);
  const visibleText = cursor.render("", "", (text) => text, undefined, maxVisibleLines);

  const cursorRef = useDeclaredCursor({
    line: cursorPosition.line - viewportStartLine,
    column: 2 + cursorPosition.column,
    active: terminalFocus
  });

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box ref={cursorRef} position="relative">
        {suggestions.length > 0 ? (
          <Box position="absolute" bottom="100%" left={0} right={0} flexDirection="column" opaque>
            <PromptInputSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
          </Box>
        ) : null}
        <Box width={2} flexShrink={0}>
          <Text>&gt; </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <PromptBufferView text={visibleText} placeholder={promptPlaceholder} />
          {imageAttachments.length ? <Text dimColor> {imageAttachments.length} image{imageAttachments.length === 1 ? "" : "s"} attached</Text> : null}
          {argumentHint ? <Text dimColor> {argumentHint}</Text> : null}
        </Box>
      </Box>
      <PromptInputQueuedCommands queued={props.queued} />
      <PromptInputStashNotice hasStash={hasStash} />

    </Box>
  );
}

function PromptBufferView({ text, placeholder }: { text: string; placeholder: string }) {
  if (!text) {
    return <Text dimColor>{placeholder}</Text>;
  }

  return <Text>{text}</Text>;
}

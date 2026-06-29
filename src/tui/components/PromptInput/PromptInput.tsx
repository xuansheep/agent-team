import React, { useEffect, useMemo, useState } from "react";


import { useTerminalFocus } from "../../../ink/hooks/use-terminal-focus.js";


import { Box, Text, useDeclaredCursor, useStdout } from "../../ink.js";


import { Cursor } from "../../../utils/Cursor.js";


import { commandArgumentHint, slashCommandSuggestions } from "../../commandCompletion.js";
import type { PermissionMode } from "../../../permissions/PermissionMode.js";


import { PromptInputEvent, PromptInputImageAttachment, PromptInputMode } from "./types.js";


import { createPromptBuffer } from "./usePromptBuffer.js";


import { createHistory } from "./usePromptHistory.js";


import { usePromptKeybindings } from "./usePromptKeybindings.js";


import { PromptInputFooter } from "./PromptInputFooter.js";




import { PromptInputModeIndicator } from "./PromptInputModeIndicator.js";


import { PromptInputQueuedCommands } from "./PromptInputQueuedCommands.js";


import { PromptInputStashNotice } from "./PromptInputStashNotice.js";


import { PromptInputSuggestions } from "./PromptInputSuggestions.js";


import { applyPromptNativeCursor } from "./PromptInputCursor.js";





export function PromptInput(props: {


  mode: PromptInputMode;


  workflowId?: string;


  queued: string[];


  workflows: string[];


  isLoading: boolean;
  permissionMode?: PermissionMode;
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


  const [buffer, setBuffer] = useState(createPromptBuffer());


  const [history, setHistory] = useState(createHistory());


  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [imageAttachments, setImageAttachments] = useState<PromptInputImageAttachment[]>([]);


  const [dismissedCompletionFor, setDismissedCompletionFor] = useState<string>();


  const rawSuggestions = useMemo(() => slashCommandSuggestions(buffer.text, { workflows: props.workflows }), [buffer.text, props.workflows]);


  const suggestions = dismissedCompletionFor === buffer.text ? [] : rawSuggestions;


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


    suggestions,


    selectedSuggestion,


    onSelectedSuggestion: updateSelectedSuggestion,


    onBuffer: setBuffer,


    onHistory: setHistory,


    onEvent: handleEvent,
    onImagePaste: (image) => setImageAttachments((current) => [...current, image]),
    resolveImagePaste: props.resolveImagePaste,


    editText: props.editText


  });





  const hasStash = Boolean(props.stash);


  const modeLabel = promptModeLabel(props.mode, props.permissionMode ?? "default");
  const inputColumns = Math.max(1, terminalColumns - 2 - modeLabel.length - 3);
  const promptPlaceholder = "Type a request or /help";
  const promptTextColumns = buffer.text.length || promptPlaceholder.length;
  const imageAttachmentText = imageAttachments.length ? ` ${imageAttachments.length} image${imageAttachments.length === 1 ? "" : "s"} attached` : "";
  const argumentHintText = argumentHint ? ` ${argumentHint}` : "";
  const promptLineColumns = modeLabel.length + 3 + promptTextColumns + imageAttachmentText.length + argumentHintText.length;
  const promptLinePadding = " ".repeat(Math.max(0, terminalColumns - promptLineColumns));


  const cursorPosition = Cursor.fromText(buffer.text, inputColumns, buffer.cursor).getPosition();


  const cursorRef = useDeclaredCursor({


    line: cursorPosition.line,


    column: modeLabel.length + 3 + cursorPosition.column,


    active: terminalFocus


  });





  return (


    <Box flexDirection="column" flexShrink={0}>


      <PromptInputSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
      <Box ref={cursorRef}>
        <PromptInputModeIndicator mode={props.mode} permissionMode={props.permissionMode ?? "default"} />
        <Text> &gt; </Text>
        <PromptBufferView text={buffer.text} placeholder={promptPlaceholder} />
        {imageAttachments.length ? <Text dimColor> {imageAttachments.length} image{imageAttachments.length === 1 ? "" : "s"} attached</Text> : null}
        {argumentHint ? <Text dimColor> {argumentHint}</Text> : null}
        {promptLinePadding ? <Text>{promptLinePadding}</Text> : null}
      </Box>
      <PromptInputQueuedCommands queued={props.queued} />


      <PromptInputStashNotice hasStash={hasStash} />


      <PromptInputFooter workflowId={props.workflowId} isLoading={props.isLoading} permissionMode={props.permissionMode ?? "default"} hasSelection={props.hasSelection ?? false} columns={terminalColumns} />


    </Box>


  );


}



function promptModeLabel(mode: PromptInputMode, permissionMode: PermissionMode): string {
  if (mode !== "input") return mode.toUpperCase();
  if (permissionMode === "acceptEdits") return "ACCEPT";
  if (permissionMode === "bypassPermissions") return "BYPASS";
  if (permissionMode === "dontAsk") return "DONTASK";
  if (permissionMode === "auto") return "AUTO";
  if (permissionMode === "plan") return "PLAN";
  return "INPUT";
}





function PromptBufferView({ text, placeholder }: { text: string; placeholder: string }) {


  if (!text) {


    return <Text dimColor>{placeholder}</Text>;


  }





  return <Text>{text}</Text>;


}

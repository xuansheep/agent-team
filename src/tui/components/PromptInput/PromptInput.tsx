import React, { useEffect, useMemo, useState } from "react";


import { useTerminalFocus } from "../../../ink/hooks/use-terminal-focus.js";


import { Box, Text, useDeclaredCursor, useStdout } from "../../ink.js";


import { Cursor } from "../../../utils/Cursor.js";


import { commandArgumentHint, slashCommandSuggestions } from "../../commandCompletion.js";


import { PromptInputEvent, PromptInputMode } from "./types.js";


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
  inputBlocked?: boolean;


  hasSelection?: boolean;


  stash?: string;


  onEvent: (event: PromptInputEvent) => void;


}) {


  const { stdout } = useStdout();


  const terminalFocus = useTerminalFocus();


  const terminalColumns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;


  const [buffer, setBuffer] = useState(createPromptBuffer());


  const [history, setHistory] = useState(createHistory());


  const [selectedSuggestion, setSelectedSuggestion] = useState(0);


  const [dismissedCompletionFor, setDismissedCompletionFor] = useState<string>();


  const rawSuggestions = useMemo(() => slashCommandSuggestions(buffer.text, { workflows: props.workflows }), [buffer.text, props.workflows]);


  const suggestions = dismissedCompletionFor === buffer.text ? [] : rawSuggestions;


  const argumentHint = commandArgumentHint(buffer.text);





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





  usePromptKeybindings({


    mode: props.mode,


    buffer,


    history,


    isLoading: props.isLoading,


    isActive: !props.inputBlocked,


    suggestions,


    selectedSuggestion,


    onSelectedSuggestion: updateSelectedSuggestion,


    onBuffer: setBuffer,


    onHistory: setHistory,


    onEvent: props.onEvent


  });





  const hasStash = Boolean(props.stash);


  const inputColumns = Math.max(1, terminalColumns - 2 - props.mode.toUpperCase().length - 3);


  const cursorPosition = Cursor.fromText(buffer.text, inputColumns, buffer.cursor).getPosition();


  const cursorRef = useDeclaredCursor({


    line: cursorPosition.line,


    column: props.mode.toUpperCase().length + 3 + cursorPosition.column,


    active: terminalFocus


  });





  return (


    <Box flexDirection="column" flexShrink={0}>


      <PromptInputSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
      <Box ref={cursorRef}>
        <PromptInputModeIndicator mode={props.mode} />
        <Text> &gt; </Text>
        <PromptBufferView text={buffer.text} placeholder="Type a request or /help" />
        {argumentHint ? <Text dimColor> {argumentHint}</Text> : null}
      </Box>
      <PromptInputQueuedCommands queued={props.queued} />


      <PromptInputStashNotice hasStash={hasStash} />


      <PromptInputFooter workflowId={props.workflowId} isLoading={props.isLoading} hasSelection={props.hasSelection ?? false} />


    </Box>


  );


}





function PromptBufferView({ text, placeholder }: { text: string; placeholder: string }) {


  if (!text) {


    return <Text dimColor>{placeholder}</Text>;


  }





  return <Text>{text}</Text>;


}



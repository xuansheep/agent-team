import React from "react";
import { Box, Text } from "../ink.js";
import { OptionWithDescription, Select } from "./CustomSelect/index.js";
import { PromptInput } from "./PromptInput/PromptInput.js";
import { PromptInputEvent, PromptInputMode } from "./PromptInput/types.js";

export type InteractionChoice = {
  title: string;
  detail?: string;
  options: OptionWithDescription<string>[];
  selectedValue: string;
  allowPromptInput?: boolean;
  visibleOptionCount?: number;
  onCancel?: () => void;
  onSubmit: (value: string) => void;
};

export function InteractionArea({
  choice,
  mode,
  workflowId,
  queued,
  workflows,
  isLoading,
  hasSelection = false,
  promptText = "",
  inputDisabled = false,
  onPromptEvent,
  onPromptTextChange
}: {
  choice?: InteractionChoice;
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  isLoading: boolean;
  hasSelection?: boolean;
  promptText?: string;
  inputDisabled?: boolean;
  onPromptEvent: (event: PromptInputEvent) => void;
  onPromptTextChange?: (text: string) => void;
}) {
  const promptHasText = promptText.trim().length > 0;
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      {choice ? (
        <Box borderStyle="single" paddingX={1} flexShrink={0}>
          <Box flexDirection="column">
            <SelectHeader title={choice.title} detail={choice.detail} />
            <Select
              options={choice.options}
              defaultValue={choice.selectedValue}
              defaultFocusValue={choice.selectedValue}
              visibleOptionCount={choice.visibleOptionCount ?? 7}
              disableSelection={choice.allowPromptInput && promptHasText}
              enableVimNavigation={!choice.allowPromptInput}
              onChange={choice.onSubmit}
              onCancel={choice.onCancel}
            />
          </Box>
        </Box>
      ) : null}
      <PromptInput
        mode={mode}
        workflowId={workflowId}
        queued={queued}
        workflows={workflows}
        isLoading={isLoading}
        inputBlocked={inputDisabled || (Boolean(choice) && !choice?.allowPromptInput)}
        hasSelection={hasSelection}
        onEvent={onPromptEvent}
        onTextChange={onPromptTextChange}
      />
    </Box>
  );
}

function SelectHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="yellow">{title}</Text>
      </Box>
      {detail ? <Text dimColor>{detail}</Text> : null}
    </Box>
  );
}

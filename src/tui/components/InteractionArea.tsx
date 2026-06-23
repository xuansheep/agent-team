import React from "react";
import { Box } from "ink";
import { ChoicePrompt, ChoicePromptOption } from "./ChoicePrompt.js";
import { PromptInput } from "./PromptInput/PromptInput.js";
import { PromptInputEvent, PromptInputMode } from "./PromptInput/types.js";

export type InteractionChoice = {
  title: string;
  detail?: string;
  options: ChoicePromptOption[];
  selectedValue: string;
  onSubmit: (value: string) => void;
};

export function InteractionArea({
  choice,
  promptTop,
  mode,
  workflowId,
  queued,
  workflows,
  isLoading,
  onPromptEvent
}: {
  choice?: InteractionChoice;
  promptTop?: number;
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  isLoading: boolean;
  onPromptEvent: (event: PromptInputEvent) => void;
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {choice ? (
        <Box borderStyle="single" paddingX={1} flexShrink={0}>
          <ChoicePrompt
            title={choice.title}
            detail={choice.detail}
            defaultValue={choice.selectedValue}
            selectedValue={choice.selectedValue}
            options={choice.options}
            interactive={false}
            onSubmit={choice.onSubmit}
          />
        </Box>
      ) : null}
      <PromptInput
        promptTop={promptTop}
        mode={mode}
        workflowId={workflowId}
        queued={queued}
        workflows={workflows}
        isLoading={isLoading}
        onEvent={onPromptEvent}
      />
    </Box>
  );
}

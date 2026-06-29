import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "../ink.js";
import { OptionWithDescription, Select, SelectImageAttachment, SelectMulti } from "./CustomSelect/index.js";
import type { PermissionMode } from "../../permissions/PermissionMode.js";
import { PromptInput } from "./PromptInput/PromptInput.js";
import { PromptInputEvent, PromptInputImageAttachment, PromptInputMode } from "./PromptInput/types.js";
import { UserQuestionPrompt } from "./UserQuestionPrompt.js";

export type InteractionChoice = {
  title: string;
  detail?: string;
  documentBlock?: { title?: string; text: string; maxLines?: number };
  questionNavigation?: QuestionNavigation;
  options: OptionWithDescription<string>[];
  footerActions?: Array<{ label: string; value: string }>;
  selectedValue: string;
  allowPromptInput?: boolean;
  visibleOptionCount?: number;
  multiSelect?: boolean;
  selectedValues?: string[];
  submitButtonText?: string;
  promptInputTakesFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (value: string) => void;
  onSubmitValues?: (values: string[]) => void;
  onPromptSubmit?: (text: string, focusedValue?: string, images?: PromptInputImageAttachment[]) => void;
  editInputText?: (text: string) => Promise<{ content: string | null; error?: string }> | { content: string | null; error?: string };
  editPromptText?: (text: string) => Promise<{ content: string | null; error?: string }> | { content: string | null; error?: string };
  imageAttachments?: SelectImageAttachment[];
  onImagePaste?: (image: Omit<SelectImageAttachment, "id">) => void;
  onRemoveImage?: (id: number) => void;
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
  onNavigate?: (direction: "previous" | "next") => void;
};

export type QuestionNavigation = {
  questions: Array<{ text: string; header: string }>;
  currentIndex: number;
  answers: Record<string, unknown>;
  hideSubmitTab?: boolean;
};

export function InteractionArea({
  choice,
  mode,
  workflowId,
  queued,
  workflows,
  questions = [],
  isLoading,
  permissionMode = "default",
  hasSelection = false,
  promptText = "",
  inputDisabled = false,
  onPromptEvent,
  onPromptTextChange,
  resolvePromptImagePaste
}: {
  choice?: InteractionChoice;
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  questions?: unknown[];
  isLoading: boolean;
  permissionMode?: PermissionMode;
  hasSelection?: boolean;
  promptText?: string;
  inputDisabled?: boolean;
  onPromptEvent: (event: PromptInputEvent) => void;
  onPromptTextChange?: (text: string) => void;
  resolvePromptImagePaste?: (value: string) => Promise<{ text: string; images: PromptInputImageAttachment[] }>;
}) {
  const promptHasText = promptText.trim().length > 0;
  const hasPreview = Boolean(!choice?.multiSelect && choice?.options.some((option) => typeof option.preview === "string" && option.preview.trim()));
  const editText = hasPreview ? choice?.editPromptText : undefined;
  const [focusedChoiceValue, setFocusedChoiceValue] = useState<string | undefined>(choice?.selectedValue);
  const [footerFocused, setFooterFocused] = useState(false);
  const [footerIndex, setFooterIndex] = useState(0);
  const [previewNotesActive, setPreviewNotesActive] = useState(false);
  useEffect(() => {
    setFocusedChoiceValue(choice?.selectedValue);
    setFooterFocused(false);
    setFooterIndex(0);
    setPreviewNotesActive(false);
  }, [choice?.selectedValue, choice?.title]);
  const footerActions = choice?.footerActions ?? [];
  const renderedOptions = useMemo(() => {
    if (!choice) return [];
    if (!hasPreview) return choice.options;
    return choice.options.map((option) => ({ ...option, description: undefined }));
  }, [choice, hasPreview]);
  const focusedPreview = useMemo(() => {
    if (!choice || !hasPreview) return undefined;
    const option = choice.options.find((item) => item.value === focusedChoiceValue) ?? choice.options[0];
    return typeof option?.preview === "string" && option.preview.trim() ? option.preview : "No preview available";
  }, [choice, focusedChoiceValue, hasPreview]);
  const focusedChoiceOption = choice?.options.find((item) => item.value === focusedChoiceValue);
  const choiceInputFocused = focusedChoiceOption?.type === "input";
  const promptInputTakesFocus = choice?.promptInputTakesFocus === true;
  const blockPromptTextInput = choiceInputFocused && !promptInputTakesFocus;
  const openChoiceInputEditor = choice?.editInputText
    ? async (currentValue: string, setValue: (value: string) => void) => {
        try {
          const result = await choice.editInputText?.(currentValue);
          if (!result) return;
          if (result.error) {
            onPromptEvent({ type: "external_editor_error", error: result.error });
            return;
          }
          if (result.content !== null) setValue(result.content);
        } catch (error) {
          onPromptEvent({ type: "external_editor_error", error: error instanceof Error ? error.message : String(error) });
        }
      }
    : undefined;
  useInput((input, _key, event) => {
    if (footerFocused && footerActions.length) {
      if (_key.upArrow || input === "\u001b[A" || (_key.ctrl && input === "p") || input === "\u0010") {
        if (footerIndex === 0) setFooterFocused(false);
        else setFooterIndex((current) => Math.max(0, current - 1));
        event.stopImmediatePropagation();
        return;
      }
      if (_key.downArrow || input === "\u001b[B" || (_key.ctrl && input === "n") || input === "\u000e") {
        setFooterIndex((current) => Math.min(footerActions.length - 1, current + 1));
        event.stopImmediatePropagation();
        return;
      }
      if (_key.return || input === "\r" || input === "\n") {
        const action = footerActions[footerIndex];
        if (action) choice?.onSubmit(action.value);
        event.stopImmediatePropagation();
        return;
      }
      if (_key.escape) {
        choice?.onCancel?.();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (choiceInputFocused && (input === "\u001b[Z" || (_key.shift && _key.tab))) {
      onPromptEvent({ type: "cycle_mode" });
      event.stopImmediatePropagation();
      return;
    }
    if (choice?.onNavigate && (input === "\u001b[D" || input === "\u001b[Z" || input === "\u001b[C" || input === "\t" || _key.leftArrow || _key.rightArrow || _key.tab)) {
      choice.onNavigate(input === "\u001b[D" || input === "\u001b[Z" || _key.leftArrow || _key.shift ? "previous" : "next");
      event.stopImmediatePropagation();
      return;
    }
    if (choice && hasPreview && !previewNotesActive && input === "n" && !_key.ctrl && !_key.meta) {
      setPreviewNotesActive(true);
      event.stopImmediatePropagation();
      return;
    }
    if (!choice || !hasPreview || promptHasText || previewNotesActive) return;
    if (input !== "j" && input !== "k") return;
    const values = choice.options.map((option) => option.value);
    if (!values.length) return;
    const currentIndex = Math.max(0, values.indexOf(focusedChoiceValue ?? choice.selectedValue));
    const delta = input === "j" ? 1 : -1;
    const nextIndex = (currentIndex + delta + values.length) % values.length;
    setFocusedChoiceValue(values[nextIndex]);
    event.stopImmediatePropagation();
  });
  const handlePromptEvent = (event: PromptInputEvent) => {
    if (event.type === "cancel" && hasPreview && previewNotesActive) {
      setPreviewNotesActive(false);
      return;
    }
    if (event.type === "submit" && (event.text.trim() || event.images?.length) && choice?.onPromptSubmit && (!hasPreview || previewNotesActive)) {
      choice.onPromptSubmit(event.text, focusedChoiceValue, event.images);
      setPreviewNotesActive(false);
      return;
    }
    onPromptEvent(event);
  };
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0} opaque>
      {choice ? (
        <Box borderStyle="single" paddingX={1} flexShrink={0} opaque>
          <Box flexDirection="column">
            {choice.questionNavigation ? <QuestionNavigationBar navigation={choice.questionNavigation} /> : null}
            <SelectHeader title={choice.title} detail={choice.documentBlock ? undefined : choice.detail} />
            {choice.documentBlock ? <ChoiceDocumentBlock block={choice.documentBlock} /> : null}
            {choice.documentBlock && choice.detail ? <ChoiceDetail detail={choice.detail} /> : null}
            <Box flexDirection={hasPreview ? "row" : "column"} gap={hasPreview ? 2 : 0}>
              <Box flexDirection="column" width={hasPreview ? 30 : undefined}>
                {choice.multiSelect ? (
                  <SelectMulti
                    isDisabled={footerFocused}
                    options={renderedOptions}
                    defaultValue={choice.selectedValues}
                    visibleOptionCount={choice.visibleOptionCount ?? 7}
                    submitButtonText={choice.submitButtonText ?? "Done"}
                    onSubmit={(values) => choice.onSubmitValues?.(values)}
                    onAction={(value) => choice.onSubmit(String(value))}
                    onCancel={choice.onCancel}
                    onDownFromLastItem={() => {
                      if (footerActions.length) setFooterFocused(true);
                    }}
                    onOpenEditor={openChoiceInputEditor}
                    imageAttachments={choice.imageAttachments}
                    onImagePaste={choice.onImagePaste}
                    onRemoveImage={choice.onRemoveImage}
                    resolveImagePaste={choice.resolveImagePaste}
                  />
                ) : (
                  <Select
                    isDisabled={footerFocused || (choice.allowPromptInput && promptHasText)}
                    options={renderedOptions}
                    defaultValue={choice.selectedValue}
                    defaultFocusValue={focusedChoiceValue ?? choice.selectedValue}
                    visibleOptionCount={choice.visibleOptionCount ?? 7}
                    disableSelection={hasPreview ? "numeric" : choice.allowPromptInput && promptHasText}
                    enableVimNavigation={!choice.allowPromptInput}
                    onFocus={setFocusedChoiceValue}
                    onChange={choice.onSubmit}
                    onCancel={choice.onCancel}
                    onDownFromLastItem={() => {
                      if (footerActions.length) setFooterFocused(true);
                    }}
                    onOpenEditor={openChoiceInputEditor}
                    inputTextDisabled={promptInputTakesFocus}
                    imageAttachments={choice.imageAttachments}
                    onImagePaste={choice.onImagePaste}
                    onRemoveImage={choice.onRemoveImage}
                    resolveImagePaste={choice.resolveImagePaste}
                  />
                )}
              </Box>
              {hasPreview ? <QuestionPreview content={focusedPreview ?? ""} notesActive={previewNotesActive} notesText={promptText} /> : null}
            </Box>
            {footerActions.length ? (
              <ChoiceFooterActions
                actions={footerActions}
                focused={footerFocused}
                focusedIndex={footerIndex}
                numbered={!hasPreview}
                startIndex={choice.options.length + 1}
              />
            ) : null}
          </Box>
        </Box>
      ) : null}
      {mode === "question" && !choice && questions.length ? <UserQuestionPrompt questions={questions} /> : null}
      <PromptInput
        key={choice?.promptInputTakesFocus ? "choice-prompt-focus" : "prompt"}
        mode={mode}
        workflowId={workflowId}
        queued={queued}
        workflows={workflows}
        isLoading={isLoading}
        permissionMode={permissionMode}
        inputBlocked={inputDisabled || (Boolean(choice) && (choice?.multiSelect || !choice?.allowPromptInput || (hasPreview && !previewNotesActive)))}
        textInputBlocked={blockPromptTextInput}
        hasSelection={hasSelection}
        editText={hasPreview && !previewNotesActive ? undefined : editText}
        resolveImagePaste={resolvePromptImagePaste}
        onEvent={handlePromptEvent}
        onTextChange={onPromptTextChange}
      />
    </Box>
  );
}

function QuestionNavigationBar({ navigation }: { navigation: QuestionNavigation }) {
  const { stdout } = useStdout();
  const columns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  const questions = navigation.questions;
  const hideArrows = questions.length === 1 && navigation.hideSubmitTab === true;
  if (questions.length <= 1 && navigation.hideSubmitTab === true) return null;
  const submitWidth = navigation.hideSubmitTab ? 0 : " ✓ Submit ".length;
  const availableForTabs = Math.max(0, columns - 4 - submitWidth);
  const labels = tabDisplayTexts(questions, navigation.currentIndex, availableForTabs);
  return (
    <Box flexDirection="row" marginBottom={1}>
      {!hideArrows ? <Text dimColor={navigation.currentIndex === 0}>← </Text> : null}
      {questions.map((question, index) => {
        const selected = index === navigation.currentIndex;
        const answered = Object.prototype.hasOwnProperty.call(navigation.answers, question.text);
        return (
          <Box key={`${question.text}:${index}`}>
            <QuestionNavigationTab selected={selected} answered={answered} label={labels[index] ?? question.header} />
          </Box>
        );
      })}
      {navigation.hideSubmitTab ? null : (
        <Box key="submit">
          <QuestionNavigationText selected={navigation.currentIndex === questions.length} text=" ✓ Submit " />
        </Box>
      )}
      {!hideArrows ? <Text dimColor={navigation.currentIndex === questions.length}> →</Text> : null}
    </Box>
  );
}

function QuestionNavigationTab({ selected, answered, label }: { selected: boolean; answered: boolean; label: string }) {
  return <QuestionNavigationText selected={selected} text={` ${answered ? "☒" : "☐"} ${label} `} />;
}

function QuestionNavigationText({ selected, text }: { selected: boolean; text: string }) {
  return selected ? <Text backgroundColor="ansi:cyan" color="ansi:black">{text}</Text> : <Text>{text}</Text>;
}

function tabDisplayTexts(questions: QuestionNavigation["questions"], currentIndex: number, availableForTabs: number): string[] {
  if (availableForTabs <= 0) return questions.map((question, index) => index === currentIndex ? question.header.slice(0, 3) : "");
  const headers = questions.map((question, index) => question.header || `Q${index + 1}`);
  const idealWidths = headers.map((header) => 4 + header.length);
  const totalIdealWidth = idealWidths.reduce((sum, width) => sum + width, 0);
  if (totalIdealWidth <= availableForTabs) return headers;

  const currentHeader = headers[currentIndex] ?? "";
  const currentWidth = Math.min(4 + currentHeader.length, Math.floor(availableForTabs / 2));
  const remainingWidth = Math.max(0, availableForTabs - currentWidth);
  const otherWidth = Math.max(6, Math.floor(remainingWidth / Math.max(questions.length - 1, 1)));
  return headers.map((header, index) => {
    const max = Math.max(1, (index === currentIndex ? currentWidth : otherWidth) - 4);
    return truncateLabel(header, max);
  });
}

function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

function ChoiceFooterActions({
  actions,
  focused,
  focusedIndex,
  numbered,
  startIndex
}: {
  actions: Array<{ label: string; value: string }>;
  focused: boolean;
  focusedIndex: number;
  numbered: boolean;
  startIndex: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {actions.map((action, index) => {
        const isFocused = focused && index === focusedIndex;
        return (
          <Box key={action.value} flexDirection="row" gap={1}>
            <Text color={isFocused ? "cyan" : undefined}>{isFocused ? ">" : " "}</Text>
            <Text color={isFocused ? "cyan" : undefined}>{numbered ? `${startIndex + index}. ${action.label}` : action.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function QuestionPreview({ content, notesActive, notesText }: { content: string; notesActive: boolean; notesText: string }) {
  const lines = content.split(/\r?\n/);
  const visible = lines.slice(0, 12);
  const hidden = Math.max(0, lines.length - visible.length);
  const minWidth = 40;
  const maxWidth = 72;
  const innerWidth = Math.max(minWidth, Math.min(maxWidth, ...visible.map((line) => line.length)));
  const horizontal = "─".repeat(innerWidth + 2);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column">
        <Text dimColor>{`┌${horizontal}┐`}</Text>
        {visible.map((line, index) => {
          const display = line.slice(0, innerWidth);
          return <Text key={index}><Text dimColor>│ </Text>{display}<Text dimColor>{`${" ".repeat(Math.max(0, innerWidth - display.length))} │`}</Text></Text>;
        })}
        {hidden ? <Text color="yellow">{previewHiddenLine(hidden, innerWidth)}</Text> : null}
        <Text dimColor>{`└${horizontal}┘`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="row" gap={1}>
        <Text color="cyan">Notes:</Text>
        <Text dimColor={!notesActive && !notesText.trim()} italic={!notesActive}>
          {notesActive ? notesText || "Add notes on this design..." : notesText.trim() || "press n to add notes"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function previewHiddenLine(hidden: number, innerWidth: number): string {
  const label = `─── ✂ ─── ${hidden} lines hidden `;
  return `├${label}${"─".repeat(Math.max(0, innerWidth + 2 - label.length))}┤`;
}

function SelectHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="yellow">{title}</Text>
      </Box>
      {detail ? <ChoiceDetail detail={detail} /> : null}
    </Box>
  );
}

function ChoiceDetail({ detail }: { detail: string }) {
  const detailLines = detail.split(/\r?\n/);
  return (
    <Box flexDirection="column">
      {detailLines.map((line, index) => (
        <Text key={index} dimColor wrap="wrap">{line || " "}</Text>
      ))}
    </Box>
  );
}

function ChoiceDocumentBlock({ block }: { block: { title?: string; text: string; maxLines?: number } }) {
  const lines = block.text.split(/\r?\n/);
  const maxLines = block.maxLines ?? 18;
  const visible = lines.slice(0, maxLines);
  const hidden = Math.max(0, lines.length - visible.length);
  const separator = "╌".repeat(72);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {block.title ? <Text wrap="wrap">{block.title}</Text> : null}
      <Box flexDirection="column" paddingX={1} overflow="hidden">
        <Text dimColor>{separator}</Text>
        {visible.map((line, index) => <ChoiceDocumentLine key={index} line={line} />)}
        {hidden ? <Text dimColor>{`... ${hidden} lines hidden`}</Text> : null}
        <Text dimColor>{separator}</Text>
      </Box>
    </Box>
  );
}

function ChoiceDocumentLine({ line }: { line: string }) {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return <Text bold wrap="wrap">{line}</Text>;
  return <Text wrap="wrap">{line || " "}</Text>;
}

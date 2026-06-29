import React, { useState } from "react";
import { Box, Text, useInput } from "../../ink.js";
import type { OptionWithDescription, SelectImageAttachment } from "./select.js";
import { Select } from "./select.js";
import { SelectOption } from "./select-option.js";

const doneValue = Symbol("select-multi-done");

export function SelectMulti<T>({
  isDisabled = false,
  options,
  defaultValue = [],
  onSubmit,
  onChange,
  onAction,
  onCancel,
  onDownFromLastItem,
  onOpenEditor,
  hideIndexes,
  visibleOptionCount,
  imageAttachments,
  onImagePaste,
  onRemoveImage,
  resolveImagePaste,
  submitButtonText
}: {
  isDisabled?: boolean;
  options: OptionWithDescription<T>[];
  defaultValue?: T[];
  onSubmit: (values: T[]) => void;
  onChange?: (values: T[]) => void;
  onAction?: (value: T) => void;
  onCancel?: () => void;
  onDownFromLastItem?: () => void;
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void;
  hideIndexes?: boolean;
  visibleOptionCount?: number;
  imageAttachments?: SelectImageAttachment[];
  onImagePaste?: (image: Omit<SelectImageAttachment, "id">) => void;
  onRemoveImage?: (id: number) => void;
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
  submitButtonText?: string;
}) {
  const [selected, setSelected] = useState<T[]>(defaultValue);
  const [focusedValue, setFocusedValue] = useState<T | typeof doneValue | undefined>(options[0]?.value);
  const [submitFocused, setSubmitFocused] = useState(false);
  const toggle = (value: T) => {
    const next = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    setSelected(next);
    onChange?.(next);
  };
  const regularOptions = options.filter((option) => !option.multiSelectAction);
  const actionOptions = options.filter((option) => option.multiSelectAction);
  const doneOption: OptionWithDescription<T | typeof doneValue> = { label: "Done", value: doneValue };
  const selectOptions: OptionWithDescription<T | typeof doneValue>[] = [
    ...regularOptions.map((option) => ({ ...option, prefix: `[${selected.includes(option.value) ? "✓" : " "}]` })),
    ...(submitButtonText ? [] : [doneOption]),
    ...actionOptions
  ];
  const focusLastSelectOption = () => {
    const value = selectOptions.at(-1)?.value;
    if (value !== undefined) setFocusedValue(value);
    setSubmitFocused(false);
  };
  useInput((input, key, event) => {
    if (isDisabled || !submitFocused || !submitButtonText) return;
    if (key.return || input === "\r" || input === "\n") {
      onSubmit(selected);
      event.stopImmediatePropagation();
      return;
    }
    if (key.escape) {
      onCancel?.();
      event.stopImmediatePropagation();
      return;
    }
    if (key.upArrow || input === "\u001b[A" || (key.ctrl && input === "p") || input === "\u0010" || input === "k") {
      focusLastSelectOption();
      event.stopImmediatePropagation();
      return;
    }
    if (key.downArrow || input === "\u001b[B" || (key.ctrl && input === "n") || input === "\u000e" || input === "j") {
      onDownFromLastItem?.();
      event.stopImmediatePropagation();
    }
  }, { isActive: !isDisabled && submitFocused && Boolean(submitButtonText) });
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Select
        isDisabled={isDisabled || submitFocused}
        options={selectOptions}
        defaultFocusValue={focusedValue}
        onFocus={setFocusedValue}
        onChange={(value) => {
          if (value === doneValue) onSubmit(selected);
          else if (options.find((option) => option.value === value)?.multiSelectAction) onAction?.(value as T);
          else toggle(value as T);
        }}
        onCancel={onCancel}
        onDownFromLastItem={() => {
          if (submitButtonText) setSubmitFocused(true);
          else onDownFromLastItem?.();
        }}
        onOpenEditor={onOpenEditor}
        hideIndexes={hideIndexes}
        visibleOptionCount={visibleOptionCount}
        imageAttachments={imageAttachments}
        onImagePaste={onImagePaste}
        onRemoveImage={onRemoveImage}
        resolveImagePaste={resolveImagePaste}
        enableInputImageSelection={false}
      />
      {submitButtonText ? (
        <SelectOption isFocused={!isDisabled && submitFocused} isSelected={false}>
          <Box flexDirection="row" flexShrink={0}>
            <Text color={!isDisabled && submitFocused ? "cyan" : undefined}>{submitButtonText}</Text>
          </Box>
        </SelectOption>
      ) : null}
    </Box>
  );
}

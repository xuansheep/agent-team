import { useEffect, useState } from "react";
import { Box, Text, useInput } from "../../ink.js";
import type { OptionWithDescription, SelectImageAttachment } from "./select.js";
import { Select } from "./select.js";
import { SelectOption } from "./select-option.js";

const doneValue = Symbol("select-multi-done");

function sameValues<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

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
  enableOrdering = false,
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
  enableOrdering?: boolean;
  submitButtonText?: string;
}) {
  const [selected, setSelected] = useState<T[]>(defaultValue);
  const [orderedValues, setOrderedValues] = useState<T[]>(() => options.map((option) => option.value));
  const [focusedValue, setFocusedValue] = useState<T | typeof doneValue | undefined>(options[0]?.value);
  const [submitFocused, setSubmitFocused] = useState(false);
  useEffect(() => {
    if (!enableOrdering) return;
    setSelected((current) => sameValues(current, defaultValue) ? current : [...defaultValue]);
  }, [defaultValue, enableOrdering]);
  useEffect(() => {
    if (!enableOrdering) return;
    const optionValues = options.map((option) => option.value);
    setOrderedValues((current) => {
      const next = [
        ...current.filter((value) => optionValues.includes(value)),
        ...optionValues.filter((value) => !current.includes(value))
      ];
      return sameValues(current, next) ? current : next;
    });
  }, [enableOrdering, options]);
  const toggle = (value: T) => {
    const toggled = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    const next = enableOrdering ? orderedValues.filter((item) => toggled.includes(item)) : toggled;
    setSelected(next);
    onChange?.(next);
  };
  const moveSelected = (delta: -1 | 1) => {
    if (focusedValue === undefined || focusedValue === doneValue) return;
    const index = selected.indexOf(focusedValue);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= selected.length) return;
    const displacedValue = selected[nextIndex]!;
    const focusedOrderIndex = orderedValues.indexOf(focusedValue);
    const displacedOrderIndex = orderedValues.indexOf(displacedValue);
    if (focusedOrderIndex < 0 || displacedOrderIndex < 0) return;
    const nextOrder = [...orderedValues];
    nextOrder[focusedOrderIndex] = displacedValue;
    nextOrder[displacedOrderIndex] = focusedValue;
    const selectedSet = new Set(selected);
    const next = nextOrder.filter((value) => selectedSet.has(value));
    setOrderedValues(nextOrder);
    setSelected(next);
    onChange?.(next);
  };
  const renderedOptions = enableOrdering ? [
    ...orderedValues.flatMap((value) => {
      const option = options.find((candidate) => candidate.value === value);
      return option ? [option] : [];
    }),
    ...options.filter((option) => !orderedValues.includes(option.value))
  ] : options;
  const regularOptions = renderedOptions.filter((option) => !option.multiSelectAction);
  const actionOptions = renderedOptions.filter((option) => option.multiSelectAction);
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
    if (isDisabled) return;
    if (!submitFocused && enableOrdering && (key.leftArrow || key.rightArrow || input === "\u001b[D" || input === "\u001b[C")) {
      moveSelected(key.leftArrow || input === "\u001b[D" ? -1 : 1);
      event.stopImmediatePropagation();
      return;
    }
    if (!submitFocused && (input === " " || event.keypress.name === "space")) {
      const focusedOption = options.find((option) => option.value === focusedValue);
      if (!focusedOption || focusedOption.disabled || focusedOption.type === "input" || focusedOption.multiSelectAction) return;
      toggle(focusedOption.value);
      event.stopImmediatePropagation();
      return;
    }
    if (!submitFocused || !submitButtonText) return;
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
  }, { isActive: !isDisabled });
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Select
        isDisabled={isDisabled || submitFocused}
        options={selectOptions}
        defaultFocusValue={focusedValue}
        selectedValues={selected}
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

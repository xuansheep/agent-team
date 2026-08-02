import { type ReactNode, useEffect, useRef, useState } from "react";
import { Box, Text } from "../../ink.js";
import { SelectInputOption } from "./select-input-option.js";
import { SelectOption } from "./select-option.js";
import { useSelectInput } from "./use-select-input.js";
import { useSelectState } from "./use-select-state.js";

type BaseOption<T> = {
  label: ReactNode;
  value: T;
  prefix?: ReactNode;
  description?: string;
  preview?: string;
  dimDescription?: boolean;
  disabled?: boolean;
  shortcut?: string;
  multiSelectAction?: boolean;
};

export type OptionWithDescription<T = string> =
  | (BaseOption<T> & { type?: "text" })
  | (BaseOption<T> & {
      type: "input";
      onChange: (value: string) => void;
      placeholder?: string;
      initialValue?: string;
      allowEmptySubmitToCancel?: boolean;
      showLabelWithValue?: boolean;
      labelValueSeparator?: string;
      resetCursorOnUpdate?: boolean;
    });

export type SelectImageAttachment = {
  id: number;
  type: "image";
  media_type: "image/png" | "image/jpeg" | "image/webp";
  data: string;
};

export function Select<T>({
  isDisabled = false,
  disableSelection = false,
  hideIndexes = false,
  visibleOptionCount = 5,
  options,
  defaultValue,
  defaultFocusValue,
  selectedValues,
  onCancel,
  onChange,
  onDelete,
  onSpace,
  onFocus,
  layout = "compact",
  inlineDescriptions = false,
  enableVimNavigation = true,
  onUpFromFirstItem,
  onDownFromLastItem,
  onInputModeToggle,
  onOpenEditor,
  inputTextDisabled = false,
  imageAttachments = [],
  onImagePaste,
  onRemoveImage,
  resolveImagePaste,
  enableInputImageSelection = true
}: {
  isDisabled?: boolean;
  disableSelection?: boolean | "numeric";
  hideIndexes?: boolean;
  visibleOptionCount?: number;
  options: OptionWithDescription<T>[];
  defaultValue?: T;
  defaultFocusValue?: T;
  selectedValues?: T[];
  onCancel?: () => void;
  onChange?: (value: T) => void;
  onDelete?: (value: T) => void;
  onSpace?: (value: T) => void;
  onFocus?: (value: T) => void;
  layout?: "compact" | "expanded" | "compact-vertical";
  inlineDescriptions?: boolean;
  enableVimNavigation?: boolean;
  onUpFromFirstItem?: () => void;
  onDownFromLastItem?: () => void;
  onInputModeToggle?: (value: T) => void;
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void;
  inputTextDisabled?: boolean;
  imageAttachments?: SelectImageAttachment[];
  onImagePaste?: (image: Omit<SelectImageAttachment, "id">) => void;
  onRemoveImage?: (id: number) => void;
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
  enableInputImageSelection?: boolean;
}) {
  const [inputValues, setInputValues] = useState<Map<T, string>>(() => inputValuesFromOptions(options));
  const lastOptionsRef = useRef(options);
  useEffect(() => {
    if (lastOptionsRef.current === options) return;
    lastOptionsRef.current = options;
    setInputValues((current) => {
      const next = new Map(current);
      for (const option of options) {
        if (option.type === "input" && option.initialValue !== undefined && !next.has(option.value)) next.set(option.value, option.initialValue);
      }
      return next;
    });
  }, [options]);

  const state = useSelectState({ visibleOptionCount, options, defaultValue, focusValue: defaultFocusValue, onChange, onCancel, onFocus });
  useSelectInput({ isDisabled, disableSelection, enableVimNavigation, state, options, inputValues, onDelete, onSpace, onInputModeToggle, onUpFromFirstItem, onDownFromLastItem });

  const maxIndexWidth = hideIndexes ? 0 : String(options.length).length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {state.visibleOptions.map((option, index) => {
        const isFocused = !isDisabled && option.value === state.focusedValue;
        const isSelected = selectedValues?.includes(option.value) ?? false;
        const isFirstVisible = option.index === state.visibleFromIndex;
        const isLastVisible = option.index === state.visibleToIndex - 1;
        const showUp = state.visibleFromIndex > 0 && isFirstVisible;
        const showDown = state.visibleToIndex < options.length && isLastVisible;
        const ordinal = state.visibleFromIndex + index + 1;
        if (option.type === "input") {
          const value = inputValues.get(option.value) ?? option.initialValue ?? "";
          return (
            <SelectInputOption
              key={String(option.value)}
              option={option}
              isFocused={isFocused}
              isSelected={isSelected}
              shouldShowDownArrow={showDown}
              shouldShowUpArrow={showUp}
              maxIndexWidth={maxIndexWidth}
              index={ordinal}
              inputValue={value}
              prefix={option.prefix}
              onInputChange={(text) => {
                setInputValues((current) => new Map(current).set(option.value, text));
                option.onChange(text);
              }}
              onSubmit={(text) => {
                if (text.trim() || imageAttachments.length || option.allowEmptySubmitToCancel) onChange?.(option.value);
              }}
              onExit={onCancel}
              onOpenEditor={onOpenEditor}
              inputTextDisabled={inputTextDisabled}
              showLabel={inlineDescriptions}
              imageAttachments={imageAttachments}
              onImagePaste={onImagePaste}
              onRemoveImage={onRemoveImage}
              resolveImagePaste={resolveImagePaste}
              enableImageSelection={enableInputImageSelection}
            />
          );
        }
        return (
          <SelectOption key={String(option.value)} isFocused={isFocused} isSelected={isSelected} shouldShowDownArrow={showDown} shouldShowUpArrow={showUp}>
            <Box flexDirection={layout === "compact" ? "row" : "column"} flexShrink={0}>
              <Box flexDirection="row" flexShrink={0}>
                {!hideIndexes ? <Text dimColor>{`${ordinal}.`.padEnd(maxIndexWidth + 2)}</Text> : null}
                {option.prefix ? <Text>{option.prefix} </Text> : null}
                <Text color={option.disabled ? undefined : isFocused ? "cyan" : isSelected ? "green" : undefined} dimColor={option.disabled}>{option.label}</Text>
                {inlineDescriptions && option.description ? <Text dimColor> {option.description}</Text> : null}
              </Box>
              {!inlineDescriptions && option.description ? (
                <Box paddingLeft={hideIndexes ? 2 : maxIndexWidth + 2}>
                  <Text dimColor={option.dimDescription !== false} wrap="wrap">{option.description}</Text>
                </Box>
              ) : null}
            </Box>
          </SelectOption>
        );
      })}
    </Box>
  );
}

function inputValuesFromOptions<T>(options: OptionWithDescription<T>[]): Map<T, string> {
  const values = new Map<T, string>();
  for (const option of options) {
    if (option.type === "input" && option.initialValue !== undefined) values.set(option.value, option.initialValue);
  }
  return values;
}

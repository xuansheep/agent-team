import React, { ReactNode, useEffect, useRef, useState } from "react";
import { Box, Text } from "../../ink.js";
import { SelectInputOption } from "./select-input-option.js";
import { SelectOption } from "./select-option.js";
import { useSelectInput } from "./use-select-input.js";
import { useSelectState } from "./use-select-state.js";

type BaseOption<T> = {
  label: ReactNode;
  value: T;
  description?: string;
  dimDescription?: boolean;
  disabled?: boolean;
  shortcut?: string;
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

export function Select<T>({
  isDisabled = false,
  disableSelection = false,
  hideIndexes = false,
  visibleOptionCount = 5,
  options,
  defaultValue,
  defaultFocusValue,
  onCancel,
  onChange,
  onFocus,
  layout = "compact",
  inlineDescriptions = false,
  enableVimNavigation = true,
  onUpFromFirstItem,
  onDownFromLastItem,
  onInputModeToggle
}: {
  isDisabled?: boolean;
  disableSelection?: boolean | "numeric";
  hideIndexes?: boolean;
  visibleOptionCount?: number;
  options: OptionWithDescription<T>[];
  defaultValue?: T;
  defaultFocusValue?: T;
  onCancel?: () => void;
  onChange?: (value: T) => void;
  onFocus?: (value: T) => void;
  layout?: "compact" | "expanded" | "compact-vertical";
  inlineDescriptions?: boolean;
  enableVimNavigation?: boolean;
  onUpFromFirstItem?: () => void;
  onDownFromLastItem?: () => void;
  onInputModeToggle?: (value: T) => void;
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
  useSelectInput({ isDisabled, disableSelection, enableVimNavigation, state, options, inputValues, onInputModeToggle, onUpFromFirstItem, onDownFromLastItem });

  const maxIndexWidth = hideIndexes ? 0 : String(options.length).length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {state.visibleOptions.map((option, index) => {
        const isFocused = !isDisabled && option.value === state.focusedValue;
        const isSelected = option.value === state.value;
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
              onInputChange={(text) => {
                setInputValues((current) => new Map(current).set(option.value, text));
                option.onChange(text);
              }}
              onSubmit={(text) => {
                if (text.trim() || option.allowEmptySubmitToCancel) onChange?.(option.value);
                else onCancel?.();
              }}
              onExit={onCancel}
              showLabel={inlineDescriptions}
            />
          );
        }
        return (
          <SelectOption key={String(option.value)} isFocused={isFocused} isSelected={isSelected} shouldShowDownArrow={showDown} shouldShowUpArrow={showUp}>
            <Box flexDirection={layout === "compact" ? "row" : "column"} flexShrink={0}>
              <Box flexDirection="row" flexShrink={0}>
                {!hideIndexes ? <Text dimColor>{`${ordinal}.`.padEnd(maxIndexWidth + 2)}</Text> : null}
                <Text color={option.disabled ? undefined : isSelected ? "green" : isFocused ? "cyan" : undefined} dimColor={option.disabled}>{option.label}</Text>
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

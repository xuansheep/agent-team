import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "../../ink.js";
import type { OptionWithDescription } from "./select.js";
import { SelectOption } from "./select-option.js";

export function SelectInputOption<T>({
  option,
  isFocused,
  isSelected,
  shouldShowDownArrow,
  shouldShowUpArrow,
  maxIndexWidth,
  index,
  inputValue,
  onInputChange,
  onSubmit,
  onExit,
  showLabel = false
}: {
  option: Extract<OptionWithDescription<T>, { type: "input" }>;
  isFocused: boolean;
  isSelected: boolean;
  shouldShowDownArrow: boolean;
  shouldShowUpArrow: boolean;
  maxIndexWidth: number;
  index: number;
  inputValue: string;
  onInputChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onExit?: () => void;
  showLabel?: boolean;
}) {
  const [cursor, setCursor] = useState(inputValue.length);
  useEffect(() => {
    if (isFocused) setCursor(inputValue.length);
  }, [inputValue.length, isFocused]);

  useInput((input, key, event) => {
    if (!isFocused) return;
    if (key.escape) {
      onExit?.();
      event.stopImmediatePropagation();
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      onSubmit(inputValue);
      event.stopImmediatePropagation();
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor <= 0) return;
      onInputChange(`${inputValue.slice(0, cursor - 1)}${inputValue.slice(cursor)}`);
      setCursor((value) => Math.max(0, value - 1));
      event.stopImmediatePropagation();
      return;
    }
    if (key.leftArrow) {
      setCursor((value) => Math.max(0, value - 1));
      event.stopImmediatePropagation();
      return;
    }
    if (key.rightArrow) {
      setCursor((value) => Math.min(inputValue.length, value + 1));
      event.stopImmediatePropagation();
      return;
    }
    if (input && !key.ctrl && !input.startsWith("\u001b")) {
      onInputChange(`${inputValue.slice(0, cursor)}${input}${inputValue.slice(cursor)}`);
      setCursor((value) => value + input.length);
      event.stopImmediatePropagation();
    }
  }, { isActive: isFocused });

  const label = showLabel || option.showLabelWithValue ? `${option.label}${option.labelValueSeparator ?? ", "}` : "";
  const placeholder = inputValue ? "" : option.placeholder ?? String(option.label);
  return (
    <SelectOption isFocused={isFocused} isSelected={isSelected} shouldShowDownArrow={shouldShowDownArrow} shouldShowUpArrow={shouldShowUpArrow} declareCursor={false}>
      <Box flexDirection="row" flexShrink={0}>
        <Text dimColor>{`${index}.`.padEnd(maxIndexWidth + 2)}</Text>
        {label ? <Text>{label}</Text> : null}
        <Text color={inputValue ? undefined : "ansi256(244)"}>{inputValue || placeholder}</Text>
      </Box>
    </SelectOption>
  );
}

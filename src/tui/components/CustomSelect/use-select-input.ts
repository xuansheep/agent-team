import { useMemo } from "react";
import { useInput } from "../../ink.js";
import type { OptionWithDescription } from "./select.js";
import type { useSelectState } from "./use-select-state.js";

type SelectState<T> = ReturnType<typeof useSelectState<T>>;

export function useSelectInput<T>({
  isDisabled = false,
  disableSelection = false,
  enableVimNavigation = true,
  state,
  options,
  inputValues,
  onInputModeToggle,
  onUpFromFirstItem,
  onDownFromLastItem
}: {
  isDisabled?: boolean;
  disableSelection?: boolean | "numeric";
  enableVimNavigation?: boolean;
  state: SelectState<T>;
  options: OptionWithDescription<T>[];
  inputValues?: Map<T, string>;
  onInputModeToggle?: (value: T) => void;
  onUpFromFirstItem?: () => void;
  onDownFromLastItem?: () => void;
}) {
  const isInInput = useMemo(() => options.find((option) => option.value === state.focusedValue)?.type === "input", [options, state.focusedValue]);

  useInput((input, key, event) => {
    if (isDisabled) return;
    const focusedOption = options.find((option) => option.value === state.focusedValue);

    if (key.escape) {
      state.onCancel?.();
      event.stopImmediatePropagation();
      return;
    }
    if (key.tab && onInputModeToggle && state.focusedValue !== undefined) {
      onInputModeToggle(state.focusedValue);
      event.stopImmediatePropagation();
      return;
    }
    if (key.pageDown) {
      state.focusNextPage();
      event.stopImmediatePropagation();
      return;
    }
    if (key.pageUp) {
      state.focusPreviousPage();
      event.stopImmediatePropagation();
      return;
    }
    if (key.downArrow || input === "\u001b[B" || (key.ctrl && input === "n") || input === "\u000e" || (enableVimNavigation && !isInInput && !key.ctrl && !key.shift && input === "j")) {
      if (onDownFromLastItem && focusedOption === options.at(-1)) onDownFromLastItem();
      else state.focusNextOption();
      event.stopImmediatePropagation();
      return;
    }
    if (key.upArrow || input === "\u001b[A" || (key.ctrl && input === "p") || input === "\u0010" || (enableVimNavigation && !isInInput && !key.ctrl && !key.shift && input === "k")) {
      if (onUpFromFirstItem && focusedOption === options[0]) onUpFromFirstItem();
      else state.focusPreviousOption();
      event.stopImmediatePropagation();
      return;
    }
    if (!isInInput && (key.return || input === "\r" || input === "\n")) {
      if (disableSelection === true || !focusedOption || focusedOption.disabled) return;
      state.selectFocusedOption();
      state.onChange?.(focusedOption.value);
      event.stopImmediatePropagation();
      return;
    }
    if (!isInInput && disableSelection !== true && /^[0-9]+$/.test(input)) {
      const index = Number(input) - 1;
      const selected = options[index];
      if (!selected || selected.disabled) return;
      if (
        disableSelection === "numeric" ||
        (selected.type === "input" && !(inputValues?.get(selected.value) ?? "").trim() && !selected.allowEmptySubmitToCancel)
      ) {
        state.focusOption(selected.value);
      } else {
        state.onChange?.(selected.value);
      }
      event.stopImmediatePropagation();
    }
  }, { isActive: !isDisabled });
}

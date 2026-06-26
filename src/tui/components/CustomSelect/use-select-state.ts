import { useCallback, useState } from "react";
import type { OptionWithDescription } from "./select.js";
import { useSelectNavigation } from "./use-select-navigation.js";

export function useSelectState<T>({
  visibleOptionCount,
  options,
  defaultValue,
  onChange,
  onCancel,
  onFocus,
  focusValue
}: {
  visibleOptionCount?: number;
  options: OptionWithDescription<T>[];
  defaultValue?: T;
  onChange?: (value: T) => void;
  onCancel?: () => void;
  onFocus?: (value: T) => void;
  focusValue?: T;
}) {
  const [value, setValue] = useState<T | undefined>(defaultValue);
  const navigation = useSelectNavigation({ visibleOptionCount, options, initialFocusValue: defaultValue, focusValue, onFocus });
  const selectFocusedOption = useCallback(() => setValue(navigation.focusedValue), [navigation.focusedValue]);
  return { ...navigation, value, selectFocusedOption, onChange, onCancel };
}

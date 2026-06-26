import { useCallback, useEffect, useMemo, useReducer } from "react";
import { OptionMap } from "./option-map.js";
import type { OptionWithDescription } from "./select.js";

type State<T> = {
  optionMap: OptionMap<T>;
  visibleOptionCount: number;
  focusedValue?: T;
  visibleFromIndex: number;
  visibleToIndex: number;
};

type Action<T> =
  | { type: "focus-next-option" }
  | { type: "focus-previous-option" }
  | { type: "focus-next-page" }
  | { type: "focus-previous-page" }
  | { type: "set-focus"; value: T }
  | { type: "reset"; state: State<T> };

export type SelectNavigation<T> = State<T> & {
  focusedIndex: number;
  options: OptionWithDescription<T>[];
  visibleOptions: Array<OptionWithDescription<T> & { index: number }>;
  isInInput: boolean;
  focusNextOption: () => void;
  focusPreviousOption: () => void;
  focusNextPage: () => void;
  focusPreviousPage: () => void;
  focusOption: (value: T | undefined) => void;
};

export function useSelectNavigation<T>({
  visibleOptionCount = 5,
  options,
  initialFocusValue,
  focusValue,
  onFocus
}: {
  visibleOptionCount?: number;
  options: OptionWithDescription<T>[];
  initialFocusValue?: T;
  focusValue?: T;
  onFocus?: (value: T) => void;
}): SelectNavigation<T> {
  const optionMap = useMemo(() => new OptionMap(options), [options]);
  const initialState = useMemo(() => createState(options, optionMap, visibleOptionCount, focusValue ?? initialFocusValue), [focusValue, initialFocusValue, optionMap, options, visibleOptionCount]);
  const [state, dispatch] = useReducer(reducer<T>, initialState);

  useEffect(() => {
    dispatch({ type: "reset", state: initialState });
  }, [initialState]);

  useEffect(() => {
    if (state.focusedValue !== undefined) onFocus?.(state.focusedValue);
  }, [onFocus, state.focusedValue]);

  const focusOption = useCallback((value: T | undefined) => {
    if (value !== undefined) dispatch({ type: "set-focus", value });
  }, []);

  const focusedOption = options.find((option) => option.value === state.focusedValue);
  return {
    ...state,
    focusedIndex: state.focusedValue === undefined ? 0 : (state.optionMap.get(state.focusedValue)?.index ?? -1) + 1,
    options,
    visibleOptions: options.slice(state.visibleFromIndex, state.visibleToIndex).map((option, index) => ({ ...option, index: state.visibleFromIndex + index })),
    isInInput: focusedOption?.type === "input",
    focusNextOption: () => dispatch({ type: "focus-next-option" }),
    focusPreviousOption: () => dispatch({ type: "focus-previous-option" }),
    focusNextPage: () => dispatch({ type: "focus-next-page" }),
    focusPreviousPage: () => dispatch({ type: "focus-previous-page" }),
    focusOption
  };
}

function createState<T>(options: OptionWithDescription<T>[], optionMap: OptionMap<T>, visibleOptionCount: number, focusValue?: T): State<T> {
  const first = focusValue !== undefined && optionMap.has(focusValue) ? focusValue : optionMap.first?.value;
  const index = first === undefined ? 0 : optionMap.get(first)?.index ?? 0;
  const visibleFromIndex = Math.max(0, Math.min(index, Math.max(0, options.length - visibleOptionCount)));
  return {
    optionMap,
    visibleOptionCount,
    focusedValue: first,
    visibleFromIndex,
    visibleToIndex: Math.min(options.length, visibleFromIndex + visibleOptionCount)
  };
}

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case "focus-next-option":
      return focusByDelta(state, 1);
    case "focus-previous-option":
      return focusByDelta(state, -1);
    case "focus-next-page":
      return focusByDelta(state, state.visibleOptionCount);
    case "focus-previous-page":
      return focusByDelta(state, -state.visibleOptionCount);
    case "set-focus":
      return focusByValue(state, action.value);
    case "reset":
      return action.state;
  }
}

function focusByDelta<T>(state: State<T>, delta: number): State<T> {
  if (state.focusedValue === undefined || state.optionMap.size === 0) return state;
  const current = state.optionMap.get(state.focusedValue);
  if (!current) return state;
  const nextIndex = ((current.index + delta) % state.optionMap.size + state.optionMap.size) % state.optionMap.size;
  let item = state.optionMap.first;
  while (item && item.index !== nextIndex) item = item.next;
  return item ? focusByValue(state, item.value) : state;
}

function focusByValue<T>(state: State<T>, value: T): State<T> {
  const item = state.optionMap.get(value);
  if (!item) return state;
  if (item.index >= state.visibleFromIndex && item.index < state.visibleToIndex) return { ...state, focusedValue: value };
  const visibleToIndex = Math.min(state.optionMap.size, item.index + 1);
  const visibleFromIndex = Math.max(0, visibleToIndex - state.visibleOptionCount);
  return { ...state, focusedValue: value, visibleFromIndex, visibleToIndex };
}

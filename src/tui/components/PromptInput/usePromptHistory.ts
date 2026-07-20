import { PromptHistory } from "./types.js";

const MAX_HISTORY_ITEMS = 100;

export function createHistory(entries: string[] = []): PromptHistory {
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  const deduplicated = normalized.filter((entry, index) => index === 0 || entry !== normalized[index - 1]);
  return { entries: deduplicated.slice(-MAX_HISTORY_ITEMS) };
}

export function pushHistory(history: PromptHistory, value: string): PromptHistory {
  const trimmed = value.trim();
  if (!trimmed) return history;
  return {
    entries: history.entries.at(-1) === trimmed
      ? history.entries
      : [...history.entries, trimmed].slice(-MAX_HISTORY_ITEMS),
    index: undefined,
    draft: undefined
  };
}

export function previousHistory(history: PromptHistory, currentValue = ""): { history: PromptHistory; value: string } {
  if (history.entries.length === 0) return { history, value: currentValue };
  const index = history.index === undefined ? history.entries.length - 1 : Math.max(0, history.index - 1);
  return {
    history: {
      ...history,
      index,
      draft: history.index === undefined ? currentValue : history.draft
    },
    value: history.entries[index] ?? currentValue
  };
}

export function nextHistory(history: PromptHistory): { history: PromptHistory; value: string } {
  if (history.entries.length === 0 || history.index === undefined) return { history, value: history.draft ?? "" };
  const index = history.index + 1;
  if (index >= history.entries.length) {
    return {
      history: { ...history, index: undefined, draft: undefined },
      value: history.draft ?? ""
    };
  }
  return { history: { ...history, index }, value: history.entries[index] ?? history.draft ?? "" };
}

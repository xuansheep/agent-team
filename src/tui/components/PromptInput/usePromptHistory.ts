import { PromptHistory } from "./types.js";

export function createHistory(): PromptHistory {
  return { entries: [] };
}

export function pushHistory(history: PromptHistory, value: string): PromptHistory {
  const trimmed = value.trim();
  if (!trimmed) return history;
  return { entries: [...history.entries.filter((entry) => entry !== trimmed), trimmed], index: undefined };
}

export function previousHistory(history: PromptHistory): { history: PromptHistory; value: string } {
  if (history.entries.length === 0) return { history, value: "" };
  const index = history.index === undefined ? history.entries.length - 1 : Math.max(0, history.index - 1);
  return { history: { ...history, index }, value: history.entries[index] ?? "" };
}

export function nextHistory(history: PromptHistory): { history: PromptHistory; value: string } {
  if (history.entries.length === 0) return { history, value: "" };
  if (history.index === undefined) return { history, value: "" };
  const index = history.index + 1;
  if (index >= history.entries.length) return { history: { ...history, index: undefined }, value: "" };
  return { history: { ...history, index }, value: history.entries[index] ?? "" };
}

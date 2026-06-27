export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ModelUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export function emptyModelUsage(): ModelUsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function hasModelUsage(usage: ModelUsage | undefined): usage is ModelUsage {
  return Boolean((usage?.inputTokens ?? 0) > 0 || (usage?.outputTokens ?? 0) > 0 || (usage?.totalTokens ?? 0) > 0);
}

export function normalizeModelUsage(usage: ModelUsage | undefined): ModelUsageTotals | undefined {
  if (!hasModelUsage(usage)) return undefined;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens
  };
}

export function addModelUsage(current: ModelUsageTotals | undefined, usage: ModelUsage | undefined): ModelUsageTotals {
  const base = current ?? emptyModelUsage();
  const next = normalizeModelUsage(usage) ?? emptyModelUsage();
  return {
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    totalTokens: base.totalTokens + next.totalTokens
  };
}

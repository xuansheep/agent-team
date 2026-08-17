export type ModelUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ModelUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
};

export function emptyModelUsage(): ModelUsageTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function hasModelUsage(usage: ModelUsage | undefined): usage is ModelUsage {
  return Boolean(
    (usage?.inputTokens ?? 0) > 0
    || (usage?.cachedInputTokens ?? 0) > 0
    || (usage?.cacheWriteInputTokens ?? 0) > 0
    || (usage?.outputTokens ?? 0) > 0
    || (usage?.totalTokens ?? 0) > 0
  );
}

export function normalizeModelUsage(usage: ModelUsage | undefined): ModelUsageTotals | undefined {
  if (!hasModelUsage(usage)) return undefined;
  const inputTokens = usage?.inputTokens ?? 0;
  const cachedInputTokens = usage?.cachedInputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    ...(usage?.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens
  };
}

export function addModelUsage(current: ModelUsage | undefined, usage: ModelUsage | undefined): ModelUsageTotals {
  const base = normalizeModelUsage(current) ?? emptyModelUsage();
  const next = normalizeModelUsage(usage) ?? emptyModelUsage();
  const hasCacheWriteInputTokens = base.cacheWriteInputTokens !== undefined || next.cacheWriteInputTokens !== undefined;
  return {
    inputTokens: base.inputTokens + next.inputTokens,
    cachedInputTokens: base.cachedInputTokens + next.cachedInputTokens,
    ...(hasCacheWriteInputTokens ? { cacheWriteInputTokens: (base.cacheWriteInputTokens ?? 0) + (next.cacheWriteInputTokens ?? 0) } : {}),
    outputTokens: base.outputTokens + next.outputTokens,
    totalTokens: base.totalTokens + next.totalTokens
  };
}

export function effectiveModelTokens(usage: ModelUsage | undefined): number {
  if (!usage) return 0;
  return Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0))
    + Math.max(0, usage.outputTokens ?? 0);
}

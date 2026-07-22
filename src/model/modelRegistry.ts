export const DEFAULT_MODEL_CONTEXT_WINDOW = 272_000;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8_000;
export const MAX_COMPACT_SUMMARY_OUTPUT_TOKENS = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const BLOCKING_BUFFER_TOKENS = 3_000;

export type ModelRegistryEntry = {
  aliases?: string[];
  contextWindow?: number;
};

export type ModelRegistry = {
  aliases?: Record<string, string>;
  defaultContextWindow?: number;
  contextWindows?: Record<string, number>;
  models?: Record<string, ModelRegistryEntry>;
};

export type ModelContextLimits = {
  contextWindow: number;
  maxOutputTokens: number;
  summaryReservedTokens: number;
  effectiveContextWindow: number;
  autoCompactLimit: number;
  blockingLimit: number;
};

export function resolveModelAlias(model: string, registry: ModelRegistry = {}): string {
  const direct = registry.aliases?.[model];
  if (direct) return direct;

  for (const [id, entry] of Object.entries(registry.models ?? {})) {
    if (entry.aliases?.includes(model)) return id;
  }
  return model;
}

export function getModelContextWindow(model: string, registry: ModelRegistry = {}): number {
  const resolved = resolveModelAlias(model, registry);
  return registry.contextWindows?.[resolved]
    ?? registry.models?.[resolved]?.contextWindow
    ?? registry.defaultContextWindow
    ?? DEFAULT_MODEL_CONTEXT_WINDOW;
}

export function getProviderMaxOutputTokens(provider: {
  type?: string;
  anthropic?: { max_tokens?: number };
}): number {
  return provider.type === "anthropic"
    ? provider.anthropic?.max_tokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS
    : DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
}

export function getModelContextLimits(
  model: string,
  registry: ModelRegistry = {},
  maxOutputTokens = DEFAULT_MODEL_MAX_OUTPUT_TOKENS
): ModelContextLimits {
  const contextWindow = getModelContextWindow(model, registry);
  const normalizedMaxOutputTokens = Math.max(1, Math.floor(maxOutputTokens));
  const summaryReservedTokens = Math.min(
    normalizedMaxOutputTokens,
    MAX_COMPACT_SUMMARY_OUTPUT_TOKENS,
    Math.max(0, contextWindow - 1)
  );
  const effectiveContextWindow = Math.max(1, contextWindow - summaryReservedTokens);
  const autoCompactLimit = Math.max(1, effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS);
  const blockingLimit = Math.max(autoCompactLimit, effectiveContextWindow - BLOCKING_BUFFER_TOKENS);
  return {
    contextWindow,
    maxOutputTokens: normalizedMaxOutputTokens,
    summaryReservedTokens,
    effectiveContextWindow,
    autoCompactLimit,
    blockingLimit
  };
}

export function modelRegistryFromProviderConfig(provider: {
  model_aliases?: Record<string, string>;
  context_windows?: Record<string, number>;
  default_context_window?: number;
}): ModelRegistry {
  return {
    aliases: provider.model_aliases ?? {},
    defaultContextWindow: provider.default_context_window,
    contextWindows: provider.context_windows ?? {}
  };
}

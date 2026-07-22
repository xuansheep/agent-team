export const DEFAULT_MODEL_CONTEXT_WINDOW = 272_000;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8_000;
export const DEFAULT_AUTO_COMPACT_PERCENT = 90;
export const DEFAULT_TOOL_OUTPUT_LIMIT_BYTES = 10_000;

export type AutoCompactTokenLimitScope = "total" | "body_after_prefix";

export type ModelRegistryEntry = {
  aliases?: string[];
  contextWindow?: number;
  autoCompactTokenLimit?: number;
  compactionHash?: string;
};

export type ModelRegistry = {
  aliases?: Record<string, string>;
  defaultContextWindow?: number;
  contextWindows?: Record<string, number>;
  defaultAutoCompactTokenLimit?: number;
  autoCompactTokenLimits?: Record<string, number>;
  compactionHashes?: Record<string, string>;
  autoCompactTokenLimitScope?: AutoCompactTokenLimitScope;
  toolOutputTokenLimit?: number;
  compactPrompt?: string;
  models?: Record<string, ModelRegistryEntry>;
};

export type ModelContextLimits = {
  contextWindow: number;
  maxOutputTokens: number;
  autoCompactLimit: number;
  autoCompactTokenLimitScope: AutoCompactTokenLimitScope;
  compactionHash?: string;
  toolOutputTokenLimit?: number;
  compactPrompt?: string;
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
  const resolved = resolveModelAlias(model, registry);
  const configuredLimit = registry.autoCompactTokenLimits?.[resolved]
    ?? registry.models?.[resolved]?.autoCompactTokenLimit
    ?? registry.defaultAutoCompactTokenLimit;
  const ninetyPercent = Math.max(1, Math.floor(contextWindow * DEFAULT_AUTO_COMPACT_PERCENT / 100));
  const autoCompactLimit = configuredLimit === undefined
    ? ninetyPercent
    : Math.max(1, Math.min(Math.floor(configuredLimit), ninetyPercent));
  return {
    contextWindow,
    maxOutputTokens: normalizedMaxOutputTokens,
    autoCompactLimit,
    autoCompactTokenLimitScope: registry.autoCompactTokenLimitScope ?? "total",
    compactionHash: registry.compactionHashes?.[resolved] ?? registry.models?.[resolved]?.compactionHash,
    toolOutputTokenLimit: registry.toolOutputTokenLimit,
    compactPrompt: registry.compactPrompt
  };
}

export function modelRegistryFromProviderConfig(provider: {
  model_aliases?: Record<string, string>;
  context_windows?: Record<string, number>;
  default_context_window?: number;
  default_auto_compact_token_limit?: number;
  auto_compact_token_limits?: Record<string, number>;
  compaction_hashes?: Record<string, string>;
  auto_compact_token_limit_scope?: AutoCompactTokenLimitScope;
  tool_output_token_limit?: number;
  compact_prompt?: string;
}): ModelRegistry {
  return {
    aliases: provider.model_aliases ?? {},
    defaultContextWindow: provider.default_context_window,
    contextWindows: provider.context_windows ?? {},
    defaultAutoCompactTokenLimit: provider.default_auto_compact_token_limit,
    autoCompactTokenLimits: provider.auto_compact_token_limits ?? {},
    compactionHashes: provider.compaction_hashes ?? {},
    autoCompactTokenLimitScope: provider.auto_compact_token_limit_scope,
    toolOutputTokenLimit: provider.tool_output_token_limit,
    compactPrompt: provider.compact_prompt
  };
}

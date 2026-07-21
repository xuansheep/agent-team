export const DEFAULT_MODEL_CONTEXT_WINDOW = 272_000;
export const DEFAULT_MODEL_CONTEXT_COMPRESSION = 258_000;

export type ModelRegistryEntry = {
  aliases?: string[];
  contextWindow?: number;
  contextCompression?: number;
};

export type ModelRegistry = {
  aliases?: Record<string, string>;
  defaultContextWindow?: number;
  defaultContextCompression?: number;
  contextWindows?: Record<string, number>;
  contextCompression?: Record<string, number>;
  models?: Record<string, ModelRegistryEntry>;
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

export function getModelContextCompression(model: string, registry: ModelRegistry = {}): number {
  const resolved = resolveModelAlias(model, registry);
  const configured = registry.contextCompression?.[resolved]
    ?? registry.models?.[resolved]?.contextCompression
    ?? registry.defaultContextCompression
    ?? DEFAULT_MODEL_CONTEXT_COMPRESSION;
  return Math.min(configured, getModelContextWindow(resolved, registry));
}

export function modelRegistryFromProviderConfig(provider: {
  model_aliases?: Record<string, string>;
  context_windows?: Record<string, number>;
  context_compression?: Record<string, number>;
  default_context_window?: number;
  default_context_compression?: number;
}): ModelRegistry {
  return {
    aliases: provider.model_aliases ?? {},
    defaultContextWindow: provider.default_context_window,
    defaultContextCompression: provider.default_context_compression,
    contextWindows: provider.context_windows ?? {},
    contextCompression: provider.context_compression ?? {}
  };
}

export type ModelRegistryEntry = {
  aliases?: string[];
  contextWindow?: number;
};

export type ModelRegistry = {
  aliases?: Record<string, string>;
  contextWindows?: Record<string, number>;
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

export function getModelContextWindow(model: string, registry: ModelRegistry = {}): number | undefined {
  const resolved = resolveModelAlias(model, registry);
  return registry.contextWindows?.[resolved] ?? registry.models?.[resolved]?.contextWindow;
}

export function modelRegistryFromProviderConfig(provider: { model_aliases?: Record<string, string>; context_windows?: Record<string, number> }): ModelRegistry {
  return {
    aliases: provider.model_aliases ?? {},
    contextWindows: provider.context_windows ?? {}
  };
}

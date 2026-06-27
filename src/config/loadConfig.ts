import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { AgentTeamConfig, configSchema } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";
import { AgentTeamSettings, ResolvedAgentTeamSettings } from "../settings/types.js";
import { resolveSettings } from "../settings/resolveSettings.js";

export type LoadConfigOptions = {
  cwd?: string;
  settings?: AgentTeamSettings | ResolvedAgentTeamSettings;
};

export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<AgentTeamConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw);
  const config = configSchema.parse(parsed);
  if (config.global_prompt_file) {
    config.global_prompt = await readFile(resolve(dirname(path), config.global_prompt_file), "utf8");
  }
  return resolveConfig(applySettings(config, options.settings, options.cwd ?? dirname(path)));
}

function applySettings(config: AgentTeamConfig, settings: LoadConfigOptions["settings"], cwd: string): AgentTeamConfig {
  if (!settings) return config;
  const resolvedSettings = resolveSettings({ cwd, projectSettings: settings });
  const models = resolvedSettings.models;
  if (!models) return config;

  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([providerId, provider]) => {
      const modelAliases = { ...provider.model_aliases, ...models.aliases };
      const contextWindows = { ...provider.context_windows, ...models.contextWindows };
      return [providerId, {
        ...provider,
        ...(models.planModel ? { plan_model: models.planModel } : {}),
        ...(Object.keys(modelAliases).length ? { model_aliases: modelAliases } : {}),
        ...(Object.keys(contextWindows).length ? { context_windows: contextWindows } : {})
      }];
    }))
  };
}

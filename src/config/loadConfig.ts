import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { configSchema } from "./schema.js";
import type { AgentTeamConfig } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";
import { AgentTeamSettings, ResolvedAgentTeamSettings } from "../settings/types.js";
import { resolveSettings } from "../settings/resolveSettings.js";
import { agentsMemoryMetadata, getAgentsMemoryFiles, getAgentsPrompt } from "../context/agentsMemory.js";

export type LoadConfigOptions = {
  cwd?: string;
  homeDir?: string;
  settings?: AgentTeamSettings | ResolvedAgentTeamSettings;
};

export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<AgentTeamConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw);
  const config = configSchema.parse(parsed) as AgentTeamConfig;
  const configDir = dirname(path);
  const cwd = options.cwd ?? configDir;
  const memoryFiles = await getAgentsMemoryFiles({
    cwd,
    configDir,
    homeDir: options.homeDir,
    configuredPromptFile: config.global_prompt_file,
    configuredPrompt: config.global_prompt,
    settings: resolveSettings({ cwd, projectSettings: options.settings })
  });
  const globalPrompt = getAgentsPrompt(memoryFiles);
  if (globalPrompt) {
    config.global_prompt = globalPrompt;
    config.global_prompt_metadata = agentsMemoryMetadata(globalPrompt, memoryFiles);
  } else {
    delete config.global_prompt;
    delete config.global_prompt_metadata;
  }
  return resolveConfig(applySettings(config, options.settings, cwd));
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

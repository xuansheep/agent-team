import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { AgentTeamConfig, configSchema } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";
import { AgentTeamSettings, ResolvedAgentTeamSettings } from "../settings/types.js";
import { resolveSettings } from "../settings/resolveSettings.js";

export type LoadConfigOptions = {
  cwd?: string;
  homeDir?: string;
  settings?: AgentTeamSettings | ResolvedAgentTeamSettings;
};

export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<AgentTeamConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw);
  const config = configSchema.parse(parsed);
  const configDir = dirname(path);
  const cwd = options.cwd ?? configDir;
  const configuredPrompt = config.global_prompt_file
    ? await readFile(resolve(configDir, config.global_prompt_file), "utf8")
    : config.global_prompt;
  const globalPrompt = joinPromptParts([
    await readOptionalPrompt(resolve(options.homeDir ?? homedir(), ".einsteins", "AGENTS.md")),
    await readOptionalPrompt(resolve(cwd, ".agents", "AGENTS.md")),
    configuredPrompt
  ]);
  if (globalPrompt) config.global_prompt = globalPrompt;
  else delete config.global_prompt;
  return resolveConfig(applySettings(config, options.settings, cwd));
}

async function readOptionalPrompt(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function joinPromptParts(parts: Array<string | undefined>): string | undefined {
  const joined = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join("\n\n");
  return joined || undefined;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
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

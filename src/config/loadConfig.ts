import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { configSchema } from "./schema.js";
import type { AgentTeamConfig, GlobalPromptMetadata, GlobalPromptSourceKind, GlobalPromptSourceMetadata } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";
import { AgentTeamSettings, ResolvedAgentTeamSettings } from "../settings/types.js";
import { resolveSettings } from "../settings/resolveSettings.js";

export type LoadConfigOptions = {
  cwd?: string;
  homeDir?: string;
  settings?: AgentTeamSettings | ResolvedAgentTeamSettings;
};

type PromptPart = {
  kind: GlobalPromptSourceKind;
  path?: string;
  content: string;
};

export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<AgentTeamConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw);
  const config = configSchema.parse(parsed) as AgentTeamConfig;
  const configDir = dirname(path);
  const cwd = options.cwd ?? configDir;
  const promptParts = [
    await readOptionalPromptPart("user_agents", resolve(options.homeDir ?? homedir(), ".einsteins", "AGENTS.md")),
    await readOptionalPromptPart("project_agents", resolve(cwd, ".agents", "AGENTS.md")),
    await configuredPromptPart(config, configDir)
  ].filter((part): part is PromptPart => Boolean(part));
  const globalPrompt = joinPromptParts(promptParts.map((part) => part.content));
  if (globalPrompt) {
    config.global_prompt = globalPrompt;
    config.global_prompt_metadata = buildGlobalPromptMetadata(globalPrompt, promptParts);
  } else {
    delete config.global_prompt;
    delete config.global_prompt_metadata;
  }
  return resolveConfig(applySettings(config, options.settings, cwd));
}

async function configuredPromptPart(config: AgentTeamConfig, configDir: string): Promise<PromptPart | undefined> {
  if (config.global_prompt_file) {
    const path = resolve(configDir, config.global_prompt_file);
    return promptPart("configured_file", path, await readFile(path, "utf8"));
  }
  return promptPart("configured_inline", undefined, config.global_prompt);
}

async function readOptionalPromptPart(kind: GlobalPromptSourceKind, path: string): Promise<PromptPart | undefined> {
  try {
    return promptPart(kind, path, await readFile(path, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function promptPart(kind: GlobalPromptSourceKind, path: string | undefined, content: string | undefined): PromptPart | undefined {
  const trimmed = content?.trim();
  if (!trimmed) return undefined;
  return { kind, path, content: trimmed };
}

function joinPromptParts(parts: string[]): string | undefined {
  const joined = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return joined || undefined;
}

function buildGlobalPromptMetadata(globalPrompt: string, parts: PromptPart[]): GlobalPromptMetadata {
  return {
    ...promptTextSummary(globalPrompt),
    sources: parts.map(promptSourceMetadata)
  };
}

function promptSourceMetadata(part: PromptPart): GlobalPromptSourceMetadata {
  return {
    kind: part.kind,
    ...(part.path ? { path: part.path } : {}),
    ...promptTextSummary(part.content)
  };
}

function promptTextSummary(content: string): { sha256: string; chars: number; lines: number } {
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    chars: content.length,
    lines: content ? content.split(/\r?\n/).length : 0
  };
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

import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { configSchema, roleFrontmatterSchema, teamFileSchema, workflowFileSchema } from "./schema.js";
import type { AgentTeamConfig, WorkflowConfig } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";
import { AgentTeamSettings, ResolvedAgentTeamSettings } from "../settings/types.js";
import { resolveSettings } from "../settings/resolveSettings.js";
import { agentsMemoryMetadata, getAgentsMemoryFiles, getAgentsPrompt, type AgentsMemoryFile } from "../context/agentsMemory.js";

export type LoadConfigOptions = {
  cwd?: string;
  homeDir?: string;
  settings?: AgentTeamSettings | ResolvedAgentTeamSettings;
  promptPath?: string;
};

export async function loadConfig(configDir: string, options: LoadConfigOptions = {}): Promise<AgentTeamConfig> {
  const resolvedConfigDir = resolve(configDir);
  const cwd = options.cwd ?? resolve(resolvedConfigDir, "..");
  const promptPath = resolve(options.promptPath ?? join(resolvedConfigDir, "prompt.md"));
  await access(promptPath);
  const [roles, workflows, teams] = await Promise.all([
    loadRoles(join(resolvedConfigDir, "roles")),
    loadWorkflows(join(resolvedConfigDir, "workflows")),
    loadTeams(join(resolvedConfigDir, "teams"))
  ]);
  const projectConfig = configSchema.parse({ roles, workflows, teams });
  const resolvedSettings = resolveSettings({ cwd, userSettings: options.settings });
  if (!resolvedSettings.dispatcher) {
    throw new Error("Missing required dispatcher configuration in ~/.einsteins/settings.json");
  }
  const config: AgentTeamConfig = {
    ...projectConfig,
    providers: applyModelSettings(resolvedSettings.providers ?? {}, resolvedSettings.models),
    dispatcher: resolvedSettings.dispatcher
  };
  const systemPrompt = (await readFile(promptPath, "utf8")).trim();
  const agentsFiles = await getAgentsMemoryFiles({
    cwd,
    homeDir: options.homeDir,
    settings: resolvedSettings
  });
  const agentsPrompt = getAgentsPrompt(agentsFiles);
  const globalPrompt = [
    systemPrompt
      ? `Mandatory system instructions from ${promptPath}. These instructions and the active role system prompt take precedence over all AGENTS.md content.\n\n${systemPrompt}`
      : undefined,
    agentsPrompt
  ].filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
  if (globalPrompt) {
    config.global_prompt = globalPrompt;
    const metadataFiles: AgentsMemoryFile[] = [
      ...(systemPrompt ? [{ path: promptPath, type: "Configured" as const, content: systemPrompt }] : []),
      ...agentsFiles
    ];
    config.global_prompt_metadata = agentsMemoryMetadata(globalPrompt, metadataFiles);
  } else {
    delete config.global_prompt;
    delete config.global_prompt_metadata;
  }
  return resolveConfig(config);
}

async function loadRoles(rolesDir: string): Promise<AgentTeamConfig["roles"]> {
  const files = await configFiles(rolesDir, ".md");
  if (!files.length) throw new Error(`No role files found in ${rolesDir}`);
  const roles = Object.create(null) as AgentTeamConfig["roles"];
  for (const file of files) {
    const path = join(rolesDir, file);
    const { metadata, body } = parseRoleMarkdown(await readFile(path, "utf8"), path);
    const role = parseFile(roleFrontmatterSchema, metadata, path, "role frontmatter");
    if (roles[role.name]) throw new Error(`Duplicate role name ${role.name} in ${path}`);
    if (!body.trim()) throw new Error(`Role prompt in ${path} must not be empty`);
    roles[role.name] = {
      description: role.description,
      system_prompt: body.trim(),
      requires: { tool_calling: true, vision: true }
    };
  }
  return roles;
}

async function loadWorkflows(workflowsDir: string): Promise<Record<string, WorkflowConfig>> {
  return loadNodeCollections(workflowsDir, "workflow", workflowFileSchema);
}

async function loadTeams(teamsDir: string): Promise<Record<string, WorkflowConfig>> {
  return loadNodeCollections(teamsDir, "team", teamFileSchema);
}

async function loadNodeCollections(
  directory: string,
  kind: "workflow" | "team",
  schema: typeof workflowFileSchema
): Promise<Record<string, WorkflowConfig>> {
  const files = await configFiles(directory, ".json");
  if (!files.length) throw new Error(`No ${kind} files found in ${directory}`);
  const configs = Object.create(null) as Record<string, WorkflowConfig>;
  for (const file of files) {
    const path = join(directory, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Invalid ${kind} JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = parseFile(schema, raw, path, kind);
    if (configs[parsed.name]) throw new Error(`Duplicate ${kind} name ${parsed.name} in ${path}`);
    configs[parsed.name] = {
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      nodes: parsed.nodes,
      edges: [],
      max_rework_cycles: parsed.max_rework_cycles,
      ...(parsed.dispatcher ? { dispatcher: parsed.dispatcher } : {}),
      ...(parsed.permissions ? { permissions: parsed.permissions } : {})
    };
  }
  return configs;
}

async function configFiles(dir: string, extension: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function parseRoleMarkdown(raw: string, path: string): { metadata: unknown; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const frontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error(`Role file ${path} must start with YAML frontmatter`);
  return {
    metadata: yaml.load(frontmatter[1] ?? "") ?? {},
    body: normalized.slice(frontmatter[0].length)
  };
}

function parseFile<Output>(schema: { parse(value: unknown): Output }, value: unknown, path: string, kind: string): Output {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${kind} in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function applyModelSettings(providers: AgentTeamConfig["providers"], models: ResolvedAgentTeamSettings["models"]): AgentTeamConfig["providers"] {
  if (!models) return providers;
  return Object.fromEntries(Object.entries(providers).map(([providerId, provider]) => {
    const modelAliases = { ...provider.model_aliases, ...models.aliases };
    const contextWindows = { ...provider.context_windows, ...models.contextWindows };
    const autoCompactTokenLimits = { ...provider.auto_compact_token_limits, ...models.autoCompactTokenLimits };
    const compactionHashes = { ...provider.compaction_hashes, ...models.compactionHashes };
    return [providerId, {
      ...provider,
      ...(models.planModel ? { plan_model: models.planModel } : {}),
      ...(models.defaultContextWindow ? { default_context_window: models.defaultContextWindow } : {}),
      ...(models.defaultAutoCompactTokenLimit ? { default_auto_compact_token_limit: models.defaultAutoCompactTokenLimit } : {}),
      ...(models.autoCompactTokenLimitScope ? { auto_compact_token_limit_scope: models.autoCompactTokenLimitScope } : {}),
      ...(models.toolOutputTokenLimit ? { tool_output_token_limit: models.toolOutputTokenLimit } : {}),
      ...(models.compactPrompt ? { compact_prompt: models.compactPrompt } : {}),
      ...(Object.keys(modelAliases).length ? { model_aliases: modelAliases } : {}),
      ...(Object.keys(contextWindows).length ? { context_windows: contextWindows } : {}),
      ...(Object.keys(autoCompactTokenLimits).length ? { auto_compact_token_limits: autoCompactTokenLimits } : {}),
      ...(Object.keys(compactionHashes).length ? { compaction_hashes: compactionHashes } : {})
    }];
  }));
}

import { isAbsolute, relative, resolve } from "node:path";
import { AgentTeamSettings, ProjectAgentTeamSettings, ResolvedAgentTeamSettings, projectSettingsSchema, settingsSchema } from "./types.js";

export type ResolveSettingsInput = {
  cwd: string;
  userSettings?: AgentTeamSettings;
  projectSettings?: ProjectAgentTeamSettings;
};

export function resolveSettings(input: ResolveSettingsInput): ResolvedAgentTeamSettings {
  const userSettings = input.userSettings ? settingsSchema.parse(input.userSettings) : {};
  const projectSettings = input.projectSettings ? projectSettingsSchema.parse(input.projectSettings) : {};
  const merged = mergeSettings(userSettings, projectSettings);

  if (!merged.plansDirectory) return merged;

  return {
    ...merged,
    plansDirectory: resolvePlansDirectory(input.cwd, merged.plansDirectory)
  };
}

export function resolvePlansDirectory(cwd: string, plansDirectory: string): string {
  const root = resolve(cwd);
  const target = isAbsolute(plansDirectory) ? resolve(plansDirectory) : resolve(root, plansDirectory);
  if (!isInsideOrSame(root, target)) {
    throw new Error(`plansDirectory must be within project root: ${plansDirectory}`);
  }
  return target;
}

function mergeSettings(userSettings: AgentTeamSettings, projectSettings: ProjectAgentTeamSettings): ResolvedAgentTeamSettings {
  const { mcpServers: _userMcpServers, projects: _projects, ...userRuntimeSettings } = userSettings;
  const { mcpServers: _projectMcpServers, ...projectRuntimeSettings } = projectSettings;
  return {
    ...userRuntimeSettings,
    ...projectRuntimeSettings,
    providers: userRuntimeSettings.providers,
    permissions: mergeObject(userRuntimeSettings.permissions, projectRuntimeSettings.permissions),
    models: mergeModels(userRuntimeSettings.models, projectRuntimeSettings.models),
    planMode: mergeObject(userRuntimeSettings.planMode, projectRuntimeSettings.planMode)
  };
}

function mergeModels(userModels: AgentTeamSettings["models"], projectModels: ProjectAgentTeamSettings["models"]): AgentTeamSettings["models"] {
  const merged = mergeObject(userModels, projectModels);
  if (!merged) return undefined;
  return {
    ...merged,
    aliases: mergeObject(userModels?.aliases, projectModels?.aliases),
    contextWindows: mergeObject(userModels?.contextWindows, projectModels?.contextWindows)
  };
}

function mergeObject<T extends Record<string, unknown>>(base: T | undefined, override: T | undefined): T | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override } as T;
}

function isInsideOrSame(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

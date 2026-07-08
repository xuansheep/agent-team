import { isAbsolute, relative, resolve } from "node:path";
import { AgentTeamSettings, ResolvedAgentTeamSettings, settingsSchema } from "./types.js";

export type ResolveSettingsInput = {
  cwd: string;
  userSettings?: AgentTeamSettings;
  projectSettings?: AgentTeamSettings;
};

export function resolveSettings(input: ResolveSettingsInput): ResolvedAgentTeamSettings {
  const userSettings = input.userSettings ? settingsSchema.parse(input.userSettings) : {};
  const projectSettings = input.projectSettings ? settingsSchema.parse(input.projectSettings) : {};
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

function mergeSettings(userSettings: AgentTeamSettings, projectSettings: AgentTeamSettings): AgentTeamSettings {
  return {
    ...userSettings,
    ...projectSettings,
    permissions: mergeObject(userSettings.permissions, projectSettings.permissions),
    models: mergeModels(userSettings.models, projectSettings.models),
    planMode: mergeObject(userSettings.planMode, projectSettings.planMode),
    hooks: mergeHooks(userSettings.hooks, projectSettings.hooks)
  };
}

function mergeModels(userModels: AgentTeamSettings["models"], projectModels: AgentTeamSettings["models"]): AgentTeamSettings["models"] {
  const merged = mergeObject(userModels, projectModels);
  if (!merged) return undefined;
  return {
    ...merged,
    aliases: mergeObject(userModels?.aliases, projectModels?.aliases),
    contextWindows: mergeObject(userModels?.contextWindows, projectModels?.contextWindows)
  };
}

function mergeHooks(userHooks: AgentTeamSettings["hooks"], projectHooks: AgentTeamSettings["hooks"]): AgentTeamSettings["hooks"] {
  if (!userHooks && !projectHooks) return undefined;
  const merged: NonNullable<AgentTeamSettings["hooks"]> = {};
  for (const source of [userHooks, projectHooks]) {
    for (const [event, matchers] of Object.entries(source ?? {})) {
      const hookEvent = event as keyof typeof merged;
      merged[hookEvent] = [...(merged[hookEvent] ?? []), ...matchers];
    }
  }
  return merged;
}

function mergeObject<T extends Record<string, unknown>>(base: T | undefined, override: T | undefined): T | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override } as T;
}

function isInsideOrSame(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

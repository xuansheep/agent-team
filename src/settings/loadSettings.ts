import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { AgentTeamSettings, ResolvedAgentTeamSettings, settingsSchema } from "./types.js";
import { resolveSettings } from "./resolveSettings.js";

export type LoadSettingsOptions = {
  cwd: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
};

export async function loadSettings(options: LoadSettingsOptions): Promise<ResolvedAgentTeamSettings> {
  const userSettings = await readSettingsFile(options.userSettingsPath ?? defaultUserSettingsPath());
  const projectSettings = await readSettingsFile(options.projectSettingsPath ?? defaultProjectSettingsPath(options.cwd));
  return resolveSettings({ cwd: options.cwd, userSettings, projectSettings });
}

export function defaultUserSettingsPath(): string {
  return join(homedir(), ".einsteins", "settings.yaml");
}

function defaultProjectSettingsPath(cwd: string): string {
  return join(cwd, ".einsteins", "settings.yaml");
}

async function readSettingsFile(path: string): Promise<AgentTeamSettings | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return settingsSchema.parse(yaml.load(raw) ?? {});
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return undefined;
  }
}

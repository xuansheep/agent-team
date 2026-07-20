import { resolve } from "node:path";
import type { AgentTeamSettings, McpProjectState } from "./types.js";

type SettingsWithProjects = Pick<AgentTeamSettings, "projects">;

export function currentProjectState(config: SettingsWithProjects | undefined, cwd: string): McpProjectState | undefined {
  const target = normalizedProjectKey(cwd);
  return Object.entries(config?.projects ?? {}).find(([key]) => normalizedProjectKey(key) === target)?.[1];
}

export function currentProjectKey(config: SettingsWithProjects | undefined, cwd: string): string {
  const target = normalizedProjectKey(cwd);
  return Object.keys(config?.projects ?? {}).find((key) => normalizedProjectKey(key) === target) ?? resolve(cwd);
}

function normalizedProjectKey(path: string): string {
  return resolve(path).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

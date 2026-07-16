import { defaultUserSettingsPath, updateUserSettingsFile } from "../settings/loadSettings.js";
import { currentProjectKey, loadMergedMcpServersWithSourceDetails, type McpConfigSourceOptions } from "./config.js";
import type { McpConfigSource } from "./schema.js";

export type McpConfigMutationResult = {
  serverName: string;
  source: McpConfigSource;
  sourcePath: string;
  disabled: boolean;
};

export async function setMcpServerDisabledState(
  options: McpConfigSourceOptions,
  serverName: string,
  disabled: boolean
): Promise<McpConfigMutationResult> {
  const effective = (await loadMergedMcpServersWithSourceDetails(options)).find((server) => server.name === serverName);
  if (!effective) throw new Error(`Unknown MCP server ${serverName}`);
  const statePath = options.userSettingsPath ?? defaultUserSettingsPath();
  await updateUserSettingsFile(statePath, (settings) => {
    const projectKey = currentProjectKey(settings, options.cwd);
    const project = settings.projects?.[projectKey] ?? {};
    return {
      ...settings,
      projects: {
        ...(settings.projects ?? {}),
        [projectKey]: {
          ...project,
          disabledMcpServers: toggleMembership(project.disabledMcpServers ?? [], serverName, disabled),
          enabledMcpServers: toggleMembership(project.enabledMcpServers ?? [], serverName, !disabled)
        }
      }
    };
  });
  return { serverName, source: "local", sourcePath: statePath, disabled };
}

function toggleMembership(values: string[], name: string, present: boolean): string[] {
  const unique = [...new Set(values)];
  const contains = unique.includes(name);
  if (contains === present) return unique;
  return present ? [...unique, name].sort() : unique.filter((value) => value !== name);
}
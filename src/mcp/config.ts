import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { defaultProjectSettingsPath, defaultUserSettingsPath } from "../settings/loadSettings.js";
import { currentProjectKey, currentProjectState } from "../settings/projectState.js";
import { projectSettingsSchema, settingsSchema, type AgentTeamSettings } from "../settings/types.js";
import { mcpServersSchema, type McpConfigSource, type McpServersConfig, type ResolvedMcpServerConfig } from "./schema.js";

export type McpConfigSourceOptions = {
  cwd: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
  managedMcpPath?: string;
};


export type McpConfigSourceFormat = "json";
export type McpConfigSourceDetail = {
  source: McpConfigSource;
  path: string;
  format: McpConfigSourceFormat;
  servers?: McpServersConfig;
};

export type McpUserSettings = Pick<AgentTeamSettings, "mcpServers" | "projects">;


export async function loadMcpConfigSourceDetails(options: McpConfigSourceOptions): Promise<McpConfigSourceDetail[]> {
  const userPath = options.userSettingsPath ?? defaultUserSettingsPath();
  const projectPath = options.projectSettingsPath ?? defaultProjectSettingsPath(options.cwd);
  const userSettings = await readUserSettings(userPath);
  const managedPath = options.managedMcpPath ?? defaultManagedMcpPath();
  const managed = await readJsonMcpServers(managedPath);

  if (managed !== undefined) {
    return [{ source: "managed", path: managedPath, format: "json", servers: managed }];
  }
  return [
    { source: "user", path: userPath, format: "json", servers: userSettings?.mcpServers },
    { source: "project", path: projectPath, format: "json", servers: await readProjectMcpServers(projectPath) }
  ];
}


export function mergeMcpServersWithSourceDetails(details: McpConfigSourceDetail[]): ResolvedMcpServerConfig[] {
  const merged = new Map<string, ResolvedMcpServerConfig>();
  for (const detail of details) {
    for (const [name, config] of Object.entries(detail.servers ?? {})) {
      merged.set(name, { ...config, name, source: detail.source, sourcePath: detail.path, sourceFormat: detail.format });
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}


export async function loadMergedMcpServersWithSourceDetails(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  const servers = mergeMcpServersWithSourceDetails(await loadMcpConfigSourceDetails(options));
  const userSettings = await readUserSettings(options.userSettingsPath ?? defaultUserSettingsPath());
  const state = currentProjectState(userSettings, options.cwd);
  const disabled = new Set(state?.disabledMcpServers ?? []);
  const enabled = new Set(state?.enabledMcpServers ?? []);
  return servers.map((server) => ({
    ...server,
    ...(disabled.has(server.name) ? { disabled: true } : enabled.has(server.name) ? { disabled: false } : {})
  }));
}



export function defaultManagedMcpPath(): string {
  if (process.env.AGENT_TEAM_MANAGED_MCP_PATH) return resolve(process.env.AGENT_TEAM_MANAGED_MCP_PATH);
  const root = process.env.AGENT_TEAM_MANAGED_DIR
    ?? (platform() === "win32" ? join(process.env.ProgramData ?? "C:\\ProgramData", "agent-team") : "/etc/agent-team");
  return join(root, "managed-mcp.json");
}

async function readUserSettings(path: string): Promise<McpUserSettings | undefined> {
  const parsed = await readJsonObject(path);
  if (!parsed) return undefined;
  const settings = settingsSchema.parse(parsed);
  return {
    ...(settings.mcpServers ? { mcpServers: parseServers(settings.mcpServers, path) } : {}),
    ...(settings.projects ? { projects: settings.projects } : {})
  };
}

async function readProjectMcpServers(path: string): Promise<McpServersConfig | undefined> {
  const parsed = await readJsonObject(path);
  if (!parsed) return undefined;
  const servers = projectSettingsSchema.parse(parsed).mcpServers;
  return servers === undefined ? undefined : parseServers(servers, path);
}

export { currentProjectKey, currentProjectState };

async function readJsonMcpServers(path: string): Promise<McpServersConfig | undefined> {
  const parsed = await readJsonObject(path);
  const servers = parsed?.mcpServers;
  return servers === undefined ? undefined : parseServers(servers, path);
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid JSON object in ${path}`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseServers(value: unknown, path: string): McpServersConfig {
  try {
    return mcpServersSchema.parse(expandEnvironment(value));
  } catch (error) {
    throw new Error(`Invalid MCP configuration in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expandEnvironment(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = process.env[name];
      if (replacement === undefined) throw new Error(`Missing environment variable ${name}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnvironment);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandEnvironment(entry)]));
}

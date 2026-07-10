import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import yaml from "js-yaml";
import { mcpServersSchema, type McpConfigSource, type McpServersConfig, type ResolvedMcpServerConfig } from "./schema.js";

export type McpConfigSourceOptions = {
  cwd: string;
  userMcpPath?: string;
  projectMcpPath?: string;
  managedMcpPath?: string;
  agentTeamPath?: string;
  agentTeamServers?: McpServersConfig;
};

export type McpConfigSources = {
  managed?: McpServersConfig;
  user?: McpServersConfig;
  project?: McpServersConfig;
  local?: McpServersConfig;
  agentTeam?: McpServersConfig;
};

export type McpConfigSourceFormat = "json" | "yaml";
export type McpConfigSourceDetail = {
  source: McpConfigSource;
  path: string;
  format: McpConfigSourceFormat;
  servers?: McpServersConfig;
};

export type EinsteinsProjectState = {
  mcpServers?: McpServersConfig;
  disabledMcpServers?: string[];
  enabledMcpServers?: string[];
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  [key: string]: unknown;
};

export type EinsteinsGlobalConfig = {
  mcpServers?: McpServersConfig;
  projects?: Record<string, EinsteinsProjectState>;
  [key: string]: unknown;
};

export async function loadMcpConfigSources(options: McpConfigSourceOptions): Promise<McpConfigSources> {
  const details = await loadMcpConfigSourceDetails(options);
  return {
    managed: mergedDetails(details, "managed"),
    user: mergedDetails(details, "user"),
    project: mergedDetails(details, "project"),
    local: mergedDetails(details, "local"),
    agentTeam: mergedDetails(details, "agent-team")
  };
}

export async function loadMcpConfigSourceDetails(options: McpConfigSourceOptions): Promise<McpConfigSourceDetail[]> {
  const userPath = options.userMcpPath ?? defaultUserMcpPath();
  const globalConfig = await readEinsteinsConfig(userPath);
  const projectState = currentProjectState(globalConfig, options.cwd);
  const managedPath = options.managedMcpPath ?? defaultManagedMcpPath();
  const managed = await readJsonMcpServers(managedPath);
  const agentTeamPath = options.agentTeamPath ?? defaultAgentTeamPath(options.cwd);
  const agentTeam = await readYamlMcpServers(agentTeamPath) ?? options.agentTeamServers;
  const details: McpConfigSourceDetail[] = [];

  if (managed !== undefined) {
    details.push({ source: "managed", path: managedPath, format: "json", servers: managed });
  } else {
    details.push({ source: "user", path: userPath, format: "json", servers: globalConfig?.mcpServers });
    const projectPaths = options.projectMcpPath ? [options.projectMcpPath] : ancestorMcpPaths(options.cwd);
    for (const path of projectPaths) details.push({ source: "project", path, format: "json", servers: await readJsonMcpServers(path) });
    details.push({ source: "local", path: userPath, format: "json", servers: projectState?.mcpServers });
  }
  details.push({ source: "agent-team", path: agentTeamPath, format: "yaml", servers: agentTeam });
  return details;
}

export function mergeMcpServers(sources: McpConfigSources): ResolvedMcpServerConfig[] {
  return mergeMcpServersWithSourceDetails([
    { source: "managed", path: defaultManagedMcpPath(), format: "json", servers: sources.managed },
    { source: "user", path: defaultUserMcpPath(), format: "json", servers: sources.user },
    { source: "project", path: "", format: "json", servers: sources.project },
    { source: "local", path: defaultUserMcpPath(), format: "json", servers: sources.local },
    { source: "agent-team", path: "", format: "yaml", servers: sources.agentTeam }
  ]);
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

export async function loadMergedMcpServers(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  return loadMergedMcpServersWithSourceDetails(options);
}

export async function loadMergedMcpServersWithSourceDetails(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  const servers = mergeMcpServersWithSourceDetails(await loadMcpConfigSourceDetails(options));
  const globalConfig = await readEinsteinsConfig(options.userMcpPath ?? defaultUserMcpPath());
  const state = currentProjectState(globalConfig, options.cwd);
  const disabled = new Set(state?.disabledMcpServers ?? []);
  const enabled = new Set(state?.enabledMcpServers ?? []);
  return servers.map((server) => ({
    ...server,
    ...(disabled.has(server.name) ? { disabled: true } : enabled.has(server.name) ? { disabled: false } : {})
  }));
}

export function defaultUserMcpPath(): string {
  return join(homedir(), ".einsteins.json");
}

export function defaultProjectMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

export function defaultManagedMcpPath(): string {
  if (process.env.AGENT_TEAM_MANAGED_MCP_PATH) return resolve(process.env.AGENT_TEAM_MANAGED_MCP_PATH);
  const root = process.env.AGENT_TEAM_MANAGED_DIR
    ?? (platform() === "win32" ? join(process.env.ProgramData ?? "C:\\ProgramData", "agent-team") : "/etc/agent-team");
  return join(root, "managed-mcp.json");
}

export function defaultAgentTeamPath(cwd: string): string {
  return join(cwd, "agent-team.yaml");
}

export async function readEinsteinsConfig(path = defaultUserMcpPath()): Promise<EinsteinsGlobalConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid JSON object in ${path}`);
    const config = parsed as EinsteinsGlobalConfig;
    return {
      ...config,
      ...(config.mcpServers ? { mcpServers: parseServers(config.mcpServers, path) } : {}),
      ...(config.projects ? { projects: Object.fromEntries(Object.entries(config.projects).map(([key, state]) => [key, {
        ...state,
        ...(state.mcpServers ? { mcpServers: parseServers(state.mcpServers, `${path}#projects.${key}`) } : {})
      }])) } : {})
    };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

export function currentProjectState(config: EinsteinsGlobalConfig | undefined, cwd: string): EinsteinsProjectState | undefined {
  const target = normalizedProjectKey(cwd);
  return Object.entries(config?.projects ?? {}).find(([key]) => normalizedProjectKey(key) === target)?.[1];
}

export function currentProjectKey(config: EinsteinsGlobalConfig | undefined, cwd: string): string {
  const target = normalizedProjectKey(cwd);
  return Object.keys(config?.projects ?? {}).find((key) => normalizedProjectKey(key) === target) ?? resolve(cwd);
}

function ancestorMcpPaths(cwd: string): string[] {
  const directories: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return directories.map((directory) => join(directory, ".mcp.json"));
}

async function readJsonMcpServers(path: string): Promise<McpServersConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid JSON object in ${path}`);
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    return servers === undefined ? undefined : parseServers(servers, path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readYamlMcpServers(path: string): Promise<McpServersConfig | undefined> {
  try {
    const parsed = yaml.load(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid YAML object in ${path}`);
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    return servers === undefined ? undefined : parseServers(servers, path);
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

function mergedDetails(details: McpConfigSourceDetail[], source: McpConfigSource): McpServersConfig | undefined {
  const matches = details.filter((detail) => detail.source === source && detail.servers !== undefined);
  if (!matches.length) return undefined;
  return Object.assign({}, ...matches.map((detail) => detail.servers));
}

function normalizedProjectKey(path: string): string {
  return resolve(path).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}
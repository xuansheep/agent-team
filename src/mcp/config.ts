import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mcpServersSchema, type McpServersConfig, type ResolvedMcpServerConfig } from "./schema.js";

const mcpJsonSchema = z.object({
  mcpServers: mcpServersSchema.optional()
}).strict();

export type McpConfigSourceOptions = {
  cwd: string;
  userMcpPath?: string;
  projectMcpPath?: string;
  agentTeamPath?: string;
  agentTeamServers?: McpServersConfig;
};

export type McpConfigSources = {
  user?: McpServersConfig;
  project?: McpServersConfig;
  agentTeam?: McpServersConfig;
};

export type McpConfigSourceFormat = "json" | "yaml";

export type McpConfigSourceDetail = {
  source: ResolvedMcpServerConfig["source"];
  path: string;
  format: McpConfigSourceFormat;
  servers?: McpServersConfig;
};

export async function loadMcpConfigSources(options: McpConfigSourceOptions): Promise<McpConfigSources> {
  const details = await loadMcpConfigSourceDetails(options);
  return {
    user: details.find((detail) => detail.source === "user")?.servers,
    project: details.find((detail) => detail.source === "project")?.servers,
    agentTeam: details.find((detail) => detail.source === "agent-team")?.servers
  };
}

export async function loadMcpConfigSourceDetails(options: McpConfigSourceOptions): Promise<McpConfigSourceDetail[]> {
  const userPath = options.userMcpPath ?? defaultUserMcpPath();
  const projectPath = options.projectMcpPath ?? defaultProjectMcpPath(options.cwd);
  return [
    { source: "user", path: userPath, format: "json", servers: await readMcpJson(userPath) },
    { source: "project", path: projectPath, format: "json", servers: await readMcpJson(projectPath) },
    { source: "agent-team", path: options.agentTeamPath ?? defaultAgentTeamPath(options.cwd), format: "yaml", servers: options.agentTeamServers }
  ];
}

export function mergeMcpServers(sources: McpConfigSources): ResolvedMcpServerConfig[] {
  return mergeMcpServersWithSourceDetails([
    { source: "user", path: defaultUserMcpPath(), format: "json", servers: sources.user },
    { source: "project", path: "", format: "json", servers: sources.project },
    { source: "agent-team", path: "", format: "yaml", servers: sources.agentTeam }
  ]);
}

export function mergeMcpServersWithSourceDetails(details: McpConfigSourceDetail[]): ResolvedMcpServerConfig[] {
  const merged = new Map<string, ResolvedMcpServerConfig>();
  for (const detail of details) addServers(merged, detail, detail.servers);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadMergedMcpServers(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  return loadMergedMcpServersWithSourceDetails(options);
}

export async function loadMergedMcpServersWithSourceDetails(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  return mergeMcpServersWithSourceDetails(await loadMcpConfigSourceDetails(options));
}

export function defaultUserMcpPath(): string {
  return join(homedir(), ".einsteins", "mcp.json");
}

export function defaultProjectMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

export function defaultAgentTeamPath(cwd: string): string {
  return join(cwd, "agent-team.yaml");
}

async function readMcpJson(path: string): Promise<McpServersConfig | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return mcpJsonSchema.parse(JSON.parse(raw)).mcpServers;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function addServers(
  target: Map<string, ResolvedMcpServerConfig>,
  detail: McpConfigSourceDetail,
  servers: McpServersConfig | undefined
): void {
  for (const [name, config] of Object.entries(servers ?? {})) {
    target.set(name, { ...config, name, source: detail.source, sourcePath: detail.path, sourceFormat: detail.format });
  }
}

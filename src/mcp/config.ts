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
  agentTeamServers?: McpServersConfig;
};

export type McpConfigSources = {
  user?: McpServersConfig;
  project?: McpServersConfig;
  agentTeam?: McpServersConfig;
};

export async function loadMcpConfigSources(options: McpConfigSourceOptions): Promise<McpConfigSources> {
  return {
    user: await readMcpJson(options.userMcpPath ?? defaultUserMcpPath()),
    project: await readMcpJson(options.projectMcpPath ?? defaultProjectMcpPath(options.cwd)),
    agentTeam: options.agentTeamServers
  };
}

export function mergeMcpServers(sources: McpConfigSources): ResolvedMcpServerConfig[] {
  const merged = new Map<string, ResolvedMcpServerConfig>();
  addServers(merged, "user", sources.user);
  addServers(merged, "project", sources.project);
  addServers(merged, "agent-team", sources.agentTeam);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadMergedMcpServers(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  return mergeMcpServers(await loadMcpConfigSources(options));
}

export function defaultUserMcpPath(): string {
  return join(homedir(), ".einsteins", "mcp.json");
}

function defaultProjectMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
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
  source: ResolvedMcpServerConfig["source"],
  servers: McpServersConfig | undefined
): void {
  for (const [name, config] of Object.entries(servers ?? {})) {
    target.set(name, { ...config, name, source });
  }
}

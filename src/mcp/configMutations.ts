import { readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { defaultAgentTeamPath, loadMcpConfigSourceDetails, mergeMcpServersWithSourceDetails, type McpConfigSourceOptions } from "./config.js";
import { mcpServersSchema, type McpServerConfig } from "./schema.js";

export type McpConfigMutationResult = {
  serverName: string;
  source: "user" | "project" | "agent-team";
  sourcePath: string;
  disabled: boolean;
};

export async function setMcpServerDisabledState(
  options: McpConfigSourceOptions,
  serverName: string,
  disabled: boolean
): Promise<McpConfigMutationResult> {
  const details = await loadMcpConfigSourceDetails(options);
  const effective = mergeMcpServersWithSourceDetails(details).find((server) => server.name === serverName);
  if (!effective) throw new Error(`Unknown MCP server ${serverName}`);
  const detail = details.find((candidate) => candidate.source === effective.source);
  if (!detail) throw new Error(`Missing MCP config source ${effective.source}`);
  if (detail.format === "json") await writeJsonDisabledState(detail.path, serverName, disabled);
  else await writeYamlDisabledState(detail.path || options.agentTeamPath || defaultAgentTeamPath(options.cwd), serverName, disabled);
  return { serverName, source: effective.source, sourcePath: detail.path, disabled };
}

async function writeJsonDisabledState(path: string, serverName: string, disabled: boolean): Promise<void> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
  const server = parsed.mcpServers?.[serverName];
  if (!server) throw new Error(`MCP server ${serverName} is not present in ${path}`);
  if (disabled) server.disabled = true;
  else delete server.disabled;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}
`, "utf8");
}

async function writeYamlDisabledState(path: string, serverName: string, disabled: boolean): Promise<void> {
  const parsed = yaml.load(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> } | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid YAML object in ${path}`);
  const servers = mcpServersSchema.parse(parsed.mcpServers ?? {});
  const server = servers[serverName];
  if (!server) throw new Error(`MCP server ${serverName} is not present in ${path}`);
  if (disabled) server.disabled = true;
  else delete server.disabled;
  parsed.mcpServers = { ...(parsed.mcpServers ?? {}), [serverName]: server };
  await writeFile(path, yaml.dump(parsed, { lineWidth: -1 }), "utf8");
}

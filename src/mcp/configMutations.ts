import { chmod, open, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { currentProjectKey, defaultUserMcpPath, loadMergedMcpServersWithSourceDetails, type EinsteinsGlobalConfig, type McpConfigSourceOptions } from "./config.js";
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
  const statePath = options.userMcpPath ?? defaultUserMcpPath();
  await withConfigLock(statePath, async () => {
    const config = await readGlobalConfigForMutation(statePath);
    const projectKey = currentProjectKey(config, options.cwd);
    const project = config.projects?.[projectKey] ?? {};
    const disabledServers = toggleMembership(project.disabledMcpServers ?? [], serverName, disabled);
    const enabledServers = toggleMembership(project.enabledMcpServers ?? [], serverName, !disabled);
    const next: EinsteinsGlobalConfig = {
      ...config,
      projects: {
        ...(config.projects ?? {}),
        [projectKey]: { ...project, disabledMcpServers: disabledServers, enabledMcpServers: enabledServers }
      }
    };
    await writeJsonAtomic(statePath, next);
  });
  return { serverName, source: "local", sourcePath: statePath, disabled };
}

async function withConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      await delay(50);
    }
  }
  if (!lock) throw new Error(`Timed out acquiring MCP config lock ${lockPath}`);
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function readGlobalConfigForMutation(path: string): Promise<EinsteinsGlobalConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid JSON object in ${path}`);
    return parsed as EinsteinsGlobalConfig;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: EinsteinsGlobalConfig): Promise<void> {
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(path)).mode;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  const handle = await open(temporaryPath, "wx", existingMode ?? 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (existingMode !== undefined) await chmod(temporaryPath, existingMode);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function toggleMembership(values: string[], name: string, present: boolean): string[] {
  const unique = [...new Set(values)];
  const contains = unique.includes(name);
  if (contains === present) return unique;
  return present ? [...unique, name].sort() : unique.filter((value) => value !== name);
}
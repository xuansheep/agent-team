import { existsSync } from "node:fs";
import { cp, mkdir, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type EnsureUserConfigOptions = {
  userConfigDir?: string;
  templateConfigDir?: string;
};

export function defaultUserConfigDir(homeDir = homedir()): string {
  return join(homeDir, ".einsteins");
}

export function defaultBundledConfigDir(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return join(directory, "config");
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Unable to locate the agent-team package root");
    directory = parent;
  }
}

export async function ensureUserRoleWorkflowConfig(options: EnsureUserConfigOptions = {}): Promise<string> {
  const userConfigDir = options.userConfigDir ?? defaultUserConfigDir();
  const templateConfigDir = options.templateConfigDir ?? defaultBundledConfigDir();
  await mkdir(userConfigDir, { recursive: true, mode: 0o700 });

  const pending: Array<{ source: string; target: string }> = [];
  for (const name of ["roles", "workflows"]) {
    const source = join(templateConfigDir, name);
    const target = join(userConfigDir, name);
    const targetStats = await pathStats(target);
    if (targetStats) {
      if (!targetStats.isDirectory()) throw new Error(`User config path must be a directory: ${target}`);
      continue;
    }
    if (!(await pathStats(source))?.isDirectory()) {
      throw new Error(`Missing bundled config template directory: ${source}`);
    }
    pending.push({ source, target });
  }

  await Promise.all(pending.map(({ source, target }) => initializeDirectory(source, target)));
  return userConfigDir;
}

async function initializeDirectory(source: string, target: string): Promise<void> {
  const staging = join(dirname(target), `.${basename(target)}.init.${process.pid}.${randomUUID()}`);
  await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
  try {
    await rename(staging, target);
  } catch (error) {
    if ((await pathStats(target))?.isDirectory()) return;
    throw error;
  }
}

async function pathStats(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

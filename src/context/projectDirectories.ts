import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export async function projectDirectoriesToGitRoot(cwd: string, homeDir = homedir()): Promise<string[]> {
  const home = normalized(resolve(homeDir));
  const directories: string[] = [];
  let current = resolve(cwd);

  for (;;) {
    if (normalized(current) === home) break;
    directories.push(current);
    if (await exists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return directories;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

function normalized(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

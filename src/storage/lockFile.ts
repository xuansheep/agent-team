import { open, stat, unlink, type FileHandle } from "node:fs/promises";

export type AcquireLockOptions = {
  attempts: number;
  delayMs: number;
  staleMs: number;
  label: string;
};

// A lock file left behind by a crashed process must not block every future write, so a lock
// older than staleMs is reclaimed instead of waited on.
export async function acquireLockFile(lockPath: string, options: AcquireLockOptions): Promise<FileHandle> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath, options.staleMs)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(options.delayMs);
    }
  }
  throw new Error(`Timed out acquiring ${options.label} ${lockPath}`);
}

export async function releaseLockFile(lock: FileHandle, lockPath: string): Promise<void> {
  await lock.close();
  await unlink(lockPath).catch(() => undefined);
}

async function isStaleLock(path: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs >= staleMs;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

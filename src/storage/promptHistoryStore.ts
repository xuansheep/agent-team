import { randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectDirectoriesToGitRoot } from "../context/projectDirectories.js";
import { logForDebugging } from "../utils/debug.js";

const MAX_HISTORY_ITEMS = 100;
const READ_CHUNK_SIZE = 4096;
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_DELAY_MS = 50;
const STALE_LOCK_MS = 10_000;

export type PromptHistoryRecord = {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
};

export type PromptHistoryStore = {
  readonly path: string;
  readonly project: string;
  readonly sessionId: string;
  readonly entries: string[];
  add(value: string): void;
  flush(): Promise<void>;
};

export type PromptHistoryStoreOptions = {
  cwd: string;
  homeDir?: string;
  path?: string;
  sessionId?: string;
};

export function defaultUserHistoryPath(homeDir = homedir()): string {
  return join(homeDir, ".einsteins", "history.jsonl");
}

export async function createPromptHistoryStore(options: PromptHistoryStoreOptions): Promise<PromptHistoryStore> {
  const path = options.path ?? defaultUserHistoryPath(options.homeDir);
  const project = await resolveProjectIdentity(options.cwd, options.homeDir);
  const sessionId = options.sessionId ?? randomUUID();
  const entries = await loadHistoryEntries({ path, project, sessionId });
  let writeQueue = Promise.resolve();

  return {
    path,
    project,
    sessionId,
    entries,
    add(value) {
      const display = value.trim();
      if (!display) return;
      entries.push(display);
      if (entries.length > MAX_HISTORY_ITEMS) entries.splice(0, entries.length - MAX_HISTORY_ITEMS);
      const record: PromptHistoryRecord = { display, timestamp: Date.now(), project, sessionId };
      writeQueue = writeQueue
        .then(() => appendHistoryRecord(path, record))
        .catch((error) => {
          logForDebugging(`Failed to write prompt history: ${error instanceof Error ? error.message : String(error)}`, { level: "warn" });
        });
    },
    async flush() {
      await writeQueue;
    }
  };
}

async function loadHistoryEntries(input: { path: string; project: string; sessionId: string }): Promise<string[]> {
  const currentSession: PromptHistoryRecord[] = [];
  const previousSessions: PromptHistoryRecord[] = [];

  try {
    for await (const line of readLinesReverse(input.path)) {
      const record = parseHistoryRecord(line);
      if (!record || normalizeProject(record.project) !== input.project) continue;
      if (record.sessionId === input.sessionId) currentSession.push(record);
      else previousSessions.push(record);
      if (currentSession.length + previousSessions.length >= MAX_HISTORY_ITEMS) break;
    }
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      logForDebugging(`Failed to read prompt history: ${error instanceof Error ? error.message : String(error)}`, { level: "warn" });
    }
  }

  return [...previousSessions.reverse(), ...currentSession.reverse()].map((record) => record.display);
}

async function appendHistoryRecord(path: string, record: PromptHistoryRecord): Promise<void> {
  await ensureHistoryFile(path);
  await withHistoryLock(path, async () => {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

async function ensureHistoryFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
}

async function withHistoryLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let lock: FileHandle | undefined;

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }

  if (!lock) throw new Error(`Timed out acquiring prompt history lock ${lockPath}`);
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs >= STALE_LOCK_MS;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

async function resolveProjectIdentity(cwd: string, homeDir?: string): Promise<string> {
  const resolvedCwd = resolve(cwd);
  const directories = await projectDirectoriesToGitRoot(resolvedCwd, homeDir);
  const candidate = directories.at(-1);
  if (candidate && await exists(join(candidate, ".git"))) return normalizeProject(candidate);
  return normalizeProject(resolvedCwd);
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

function parseHistoryRecord(line: string): PromptHistoryRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<PromptHistoryRecord>;
    if (
      typeof value.display !== "string" ||
      !value.display.trim() ||
      typeof value.timestamp !== "number" ||
      !Number.isFinite(value.timestamp) ||
      typeof value.project !== "string" ||
      !value.project.trim() ||
      typeof value.sessionId !== "string" ||
      !value.sessionId.trim()
    ) {
      return undefined;
    }
    return {
      display: value.display,
      timestamp: value.timestamp,
      project: value.project,
      sessionId: value.sessionId
    };
  } catch {
    return undefined;
  }
}

function normalizeProject(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function* readLinesReverse(path: string): AsyncGenerator<string> {
  const handle = await open(path, "r");
  try {
    let position = (await handle.stat()).size;
    let remainder = Buffer.alloc(0);
    const buffer = Buffer.alloc(READ_CHUNK_SIZE);

    while (position > 0) {
      const chunkSize = Math.min(READ_CHUNK_SIZE, position);
      position -= chunkSize;
      await handle.read(buffer, 0, chunkSize, position);
      const combined = Buffer.concat([buffer.subarray(0, chunkSize), remainder]);
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline === -1) {
        remainder = combined;
        continue;
      }

      remainder = Buffer.from(combined.subarray(0, firstNewline));
      const lines = combined.toString("utf8", firstNewline + 1).split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line) yield line;
      }
    }

    if (remainder.length) yield remainder.toString("utf8");
  } finally {
    await handle.close();
  }
}

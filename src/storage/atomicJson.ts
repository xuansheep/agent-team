import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { acquireFileLease } from "./fileLease.js";

const writeQueues = new Map<string, Promise<unknown>>();

export type AtomicJsonOptions = {
  backupPath?: string | false;
};

export async function readJsonWithBackup<T>(path: string, options: AtomicJsonOptions = {}): Promise<T | undefined> {
  const primary = await readJsonFile<T>(path);
  if (primary.value !== undefined) return primary.value;
  const backupPath = resolveBackupPath(path, options.backupPath);
  if (!backupPath) {
    if (primary.error) throw primary.error;
    return undefined;
  }
  const backup = await readJsonFile<T>(backupPath);
  if (backup.value !== undefined) return backup.value;
  if (primary.error) throw primary.error;
  if (backup.error) throw backup.error;
  return undefined;
}

export async function updateJsonAtomic<T>(
  path: string,
  update: (current: T | undefined) => T | Promise<T>,
  options: AtomicJsonOptions = {}
): Promise<T> {
  const absolutePath = resolve(path);
  return enqueue(absolutePath, async () => {
    const lease = await acquireFileLease(`${absolutePath}.lease`, `JSON file ${absolutePath}`, { wait: true });
    try {
      const primary = await readJsonFile<T>(absolutePath);
      const backupPath = resolveBackupPath(absolutePath, options.backupPath);
      const backup = primary.value === undefined && backupPath ? await readJsonFile<T>(backupPath) : { value: undefined };
      if (primary.error && !(primary.error instanceof SyntaxError)) throw primary.error;
      if (backup.error && !(backup.error instanceof SyntaxError)) throw backup.error;
      const current = primary.value ?? backup.value;
      const next = await update(current);
      const serialized = `${JSON.stringify(next, null, 2)}\n`;

      if (primary.error instanceof SyntaxError) {
        await preserveCorruptFile(absolutePath);
      } else if (primary.raw !== undefined && backupPath) {
        await writeTextAtomic(backupPath, primary.raw);
      }
      await writeTextAtomic(absolutePath, serialized);
      if (primary.raw === undefined && backupPath) {
        await writeTextAtomic(backupPath, serialized);
      }
      return next;
    } finally {
      await lease.release();
    }
  });
}

export async function writeJsonAtomic<T>(path: string, value: T, options: AtomicJsonOptions = {}): Promise<T> {
  return updateJsonAtomic(path, () => value, options);
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rename(tempPath, `${path}.failed-${Date.now()}-${randomUUID()}`).catch(() => undefined);
    throw error;
  }
}

async function preserveCorruptFile(path: string): Promise<void> {
  await rename(path, `${path.slice(0, path.length - extname(path).length)}.corrupt-${Date.now()}-${randomUUID()}${extname(path)}`).catch((error: unknown) => {
    if (!isErrno(error, "ENOENT")) throw error;
  });
}

async function readJsonFile<T>(path: string): Promise<{ value?: T; raw?: string; error?: unknown }> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return { raw, error: new SyntaxError(`Empty JSON file ${path}`) };
    try {
      return { raw, value: JSON.parse(raw) as T };
    } catch (error) {
      return { raw, error };
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    return { error };
  }
}

function resolveBackupPath(path: string, configured: string | false | undefined): string | undefined {
  if (configured === false) return undefined;
  if (configured) return configured;
  const extension = extname(path);
  return extension ? `${path.slice(0, path.length - extension.length)}.backup${extension}` : `${path}.backup`;
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const settled = next.catch(() => undefined);
  writeQueues.set(key, settled);
  return next.finally(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

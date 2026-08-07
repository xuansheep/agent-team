import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type LeaseRecord = {
  owner_id: string;
  hostname: string;
  pid: number;
  acquired_at: string;
  heartbeat_at: string;
};

export type FileLease = { release(): Promise<void> };

const heartbeatIntervalMs = 5_000;
const staleLeaseMs = 30_000;

export async function acquireFileLease(path: string, purpose: string, options: { wait?: boolean; timeoutMs?: number } = {}): Promise<FileLease> {
  await mkdir(dirname(path), { recursive: true });
  const ownerId = randomUUID();
  const acquiredAt = new Date().toISOString();
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const record = (): LeaseRecord => ({
    owner_id: ownerId,
    hostname: hostname(),
    pid: process.pid,
    acquired_at: acquiredAt,
    heartbeat_at: new Date().toISOString()
  });

  for (;;) {
    try {
      await writeFile(path, `${JSON.stringify(record())}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      const windowsLeaseConflict = process.platform === "win32" && isErrno(error, "EPERM");
      if (!isErrno(error, "EEXIST") && !windowsLeaseConflict) throw error;

      let existing: { record?: LeaseRecord; modifiedAt: number } | undefined;
      try {
        existing = await readLease(path);
      } catch (readError) {
        if (windowsLeaseConflict && options.wait && Date.now() < deadline && isErrno(readError, "EPERM")) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw readError;
      }

      if (!existing && windowsLeaseConflict) {
        if (options.wait && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw error;
      }

      if (!existing || (existing.record ? leaseIsActive(existing.record, existing.modifiedAt) : Date.now() - existing.modifiedAt < staleLeaseMs)) {
        if (options.wait && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        const owner = existing?.record;
        throw new Error(`${purpose} is already active${owner ? ` (pid ${owner.pid} on ${owner.hostname})` : ""}`);
      }
      await retireLease(path, "stale").catch((retireError: unknown) => {
        if (!isErrno(retireError, "ENOENT")) throw retireError;
      });
    }
  }

  let released = false;
  let heartbeatWrite = Promise.resolve();
  const timer = setInterval(() => {
    heartbeatWrite = heartbeatWrite.then(async () => {
      const current = await readLease(path);
      if (current?.record?.owner_id === ownerId) await writeFile(path, `${JSON.stringify(record())}\n`, "utf8");
    }).catch(() => undefined);
  }, heartbeatIntervalMs);
  timer.unref();

  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await heartbeatWrite;
      const current = await readLease(path);
      if (current?.record?.owner_id === ownerId) {
        await unlink(path).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      }
    }
  };
}

async function readLease(path: string): Promise<{ record?: LeaseRecord; modifiedAt: number } | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    try {
      const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
      if (typeof parsed.owner_id !== "string" || typeof parsed.hostname !== "string" || typeof parsed.pid !== "number") return { modifiedAt: info.mtimeMs };
      return { record: parsed as LeaseRecord, modifiedAt: info.mtimeMs };
    } catch (error) {
      if (error instanceof SyntaxError) return { modifiedAt: info.mtimeMs };
      throw error;
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function leaseIsActive(record: LeaseRecord, modifiedAt: number): boolean {
  if (record.hostname === hostname()) return processIsAlive(record.pid);
  return Date.now() - modifiedAt < staleLeaseMs;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function retireLease(path: string, status: "stale"): Promise<void> {
  const historyDir = join(dirname(path), ".lease-history");
  await mkdir(historyDir, { recursive: true });
  await rename(path, join(historyDir, `${Date.now()}-${status}-${randomUUID()}.json`));
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

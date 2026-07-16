import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AuditEvent, normalizeAuditEvent } from "./auditEvent.js";
import { acquireFileLease } from "../storage/fileLease.js";

const GENESIS_HASH = "0".repeat(64);
const writeQueues = new Map<string, Promise<unknown>>();

export type AuditRecord = AuditEvent & {
  seq: number;
  prev_hash: string;
  hash: string;
};

export type AuditVerification = {
  valid: boolean;
  count: number;
  lastHash: string;
  error?: string;
};

export class AuditStore {
  readonly path: string;

  constructor(sessionDir: string) {
    this.path = join(sessionDir, "audit.ndjson");
  }

  async append(event: AuditEvent): Promise<AuditRecord> {
    const key = resolve(this.path);
    return enqueue(key, async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const lease = await acquireFileLease(`${this.path}.lease`, `Audit log ${this.path}`, { wait: true });
      try {
        const current = await this.readRecords();
        const verification = verifyRecords(current);
        if (!verification.valid) {
          throw new Error(`Audit chain verification failed before append: ${verification.error}`);
        }
        const normalized = normalizeAuditEvent(event);
        const body = {
          ...normalized,
          seq: current.length + 1,
          prev_hash: verification.lastHash
        };
        const record: AuditRecord = { ...body, hash: hashRecordBody(body) };
        const handle = await open(this.path, "a", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return record;
      } finally {
        await lease.release();
      }
    });
  }

  async readEvents(): Promise<AuditRecord[]> {
    return this.readRecords();
  }

  async verify(): Promise<AuditVerification> {
    try {
      return verifyRecords(await this.readRecords());
    } catch (error) {
      return {
        valid: false,
        count: 0,
        lastHash: GENESIS_HASH,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async readRecords(): Promise<AuditRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    if (!raw.trim()) return [];
    const lines = raw.split("\n");
    const records: AuditRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch (error) {
        throw new SyntaxError(`Invalid audit JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return records;
  }
}

function verifyRecords(records: AuditRecord[]): AuditVerification {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const expectedSeq = index + 1;
    if (record.seq !== expectedSeq) {
      return invalid(records, previousHash, `expected seq ${expectedSeq}, received ${String(record.seq)}`);
    }
    if (record.prev_hash !== previousHash) {
      return invalid(records, previousHash, `prev_hash mismatch at seq ${expectedSeq}`);
    }
    const { hash, ...body } = record;
    const expectedHash = hashRecordBody(body);
    if (hash !== expectedHash) {
      return invalid(records, previousHash, `hash mismatch at seq ${expectedSeq}`);
    }
    previousHash = hash;
  }
  return { valid: true, count: records.length, lastHash: previousHash };
}

function invalid(records: AuditRecord[], lastHash: string, error: string): AuditVerification {
  return { valid: false, count: records.length, lastHash, error };
}

function hashRecordBody(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
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

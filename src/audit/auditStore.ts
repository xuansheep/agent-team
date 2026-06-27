import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuditEvent, normalizeAuditEvent } from "./auditEvent.js";

export class AuditStore {
  readonly path: string;

  constructor(root = ".session") {
    this.path = join(root, "audit.ndjson");
  }

  async append(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(normalizeAuditEvent(event))}\n`, "utf8");
  }

  async readEvents(): Promise<AuditEvent[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      return raw.split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as AuditEvent);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return [];
      throw error;
    }
  }
}

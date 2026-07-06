import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionIndexEntry = {
  sessionId: string;
  sessionDir: string;
  metadataPath: string;
  updatedAt: string;
  status?: string;
  workflowRunId?: string;
};

export type IndexedRunSummary = {
  runId: string;
  runDir: string;
  workflowId: string;
  status: string;
  currentNodeId?: string;
  startedAt?: string;
  updatedAt: string;
  inputPreview: string;
};

export type RootIndex = {
  version: 1;
  sessions?: SessionIndexEntry[];
  runs?: IndexedRunSummary[];
};

export class SessionIndex {
  constructor(private readonly rootDir = ".session") {}

  async upsert(entry: SessionIndexEntry): Promise<void> {
    const index = await readRootIndex(this.rootDir) ?? { version: 1 };
    const sessions = [...index.sessions ?? []].filter((item) => item.sessionId !== entry.sessionId);
    sessions.push(entry);
    await writeRootIndex(this.rootDir, { ...index, sessions: sortSessions(sessions) });
  }

  async list(): Promise<SessionIndexEntry[]> {
    const index = await readRootIndex(this.rootDir);
    return sortSessions(index?.sessions ?? []);
  }

  async rebuildFromMetadata(): Promise<SessionIndexEntry[]> {
    let months;
    try {
      months = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const entries: SessionIndexEntry[] = [];
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{6}$/.test(month.name)) continue;
      const monthDir = join(this.rootDir, month.name);
      const sessionDirs = await readdir(monthDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      });
      for (const session of sessionDirs) {
        if (!session.isDirectory()) continue;
        const sessionDir = join(monthDir, session.name);
        const metadataPath = join(sessionDir, "metadata.json");
        try {
          const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { sessionId?: unknown; updatedAt?: unknown; status?: unknown; workflowRunId?: unknown };
          if (typeof metadata.sessionId !== "string" || typeof metadata.updatedAt !== "string") continue;
          entries.push({
            sessionId: metadata.sessionId,
            sessionDir,
            metadataPath,
            updatedAt: metadata.updatedAt,
            ...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
            ...(typeof metadata.workflowRunId === "string" ? { workflowRunId: metadata.workflowRunId } : {})
          });
        } catch {
          // Ignore partially written session metadata.
        }
      }
    }

    const index = await readRootIndex(this.rootDir) ?? { version: 1 };
    await writeRootIndex(this.rootDir, { ...index, sessions: sortSessions(entries) });
    return sortSessions(entries);
  }
}

export async function readRootIndex(rootDir: string): Promise<RootIndex | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(rootDir, "index.json"), "utf8")) as RootIndex;
    if (!parsed || parsed.version !== 1) return undefined;
    return {
      version: 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isSessionIndexEntry) : undefined,
      runs: Array.isArray(parsed.runs) ? parsed.runs.filter(isIndexedRunSummary) : undefined
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeRootIndex(rootDir: string, index: RootIndex): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "index.json"), `${JSON.stringify(index, null, 2)}
`, "utf8");
}

function sortSessions(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return entries.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.sessionId.localeCompare(a.sessionId));
}

function isSessionIndexEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sessionId === "string" && typeof entry.sessionDir === "string" && typeof entry.metadataPath === "string" && typeof entry.updatedAt === "string";
}

function isIndexedRunSummary(value: unknown): value is IndexedRunSummary {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.runId === "string" && typeof entry.runDir === "string" && typeof entry.workflowId === "string" && typeof entry.status === "string" && typeof entry.updatedAt === "string" && typeof entry.inputPreview === "string";
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

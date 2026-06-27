import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionIndexEntry = {
  sessionId: string;
  metadataPath: string;
  updatedAt: string;
  status?: string;
  workflowRunId?: string;
};

export type IndexedRunSummary = {
  runId: string;
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
    const sessionsDir = join(this.rootDir, "sessions");
    let dirs;
    try {
      dirs = await readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }

    const entries: SessionIndexEntry[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const metadataPath = join(sessionsDir, dir.name, "metadata.json");
      try {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { sessionId?: unknown; updatedAt?: unknown; status?: unknown; workflowRunId?: unknown };
        if (typeof metadata.sessionId !== "string" || typeof metadata.updatedAt !== "string") continue;
        entries.push({
          sessionId: metadata.sessionId,
          metadataPath,
          updatedAt: metadata.updatedAt,
          ...(typeof metadata.status === "string" ? { status: metadata.status } : {}),
          ...(typeof metadata.workflowRunId === "string" ? { workflowRunId: metadata.workflowRunId } : {})
        });
      } catch {
        // Ignore partially written session metadata.
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
    return parsed && parsed.version === 1 ? parsed : undefined;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeRootIndex(rootDir: string, index: RootIndex): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function sortSessions(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return entries.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.sessionId.localeCompare(a.sessionId));
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

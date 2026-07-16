import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelMessage } from "../providers/types.js";
import { PlanSessionState } from "../plans/planSession.js";
import { addModelUsage, ModelUsage, ModelUsageTotals } from "../model/usage.js";
import type { PromptInjectionRecord } from "../runtime/types.js";
import { readJsonWithBackup, updateJsonAtomic } from "./atomicJson.js";
import { acquireFileLease } from "./fileLease.js";
import { projectDirectory, projectPath, ProjectStorageContext, sessionDirectory } from "./projectStorage.js";

export type TranscriptEntry = {
  ts: string;
  message: ModelMessage;
  runId?: string;
};

export type SessionMetadata = {
  version: 1;
  sessionId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  currentRunId?: string;
  runIds: string[];
  inputPreview?: string;
  plan?: PlanSessionState;
  usage?: ModelUsageTotals;
  promptInjection?: {
    globalPrompt?: PromptInjectionRecord;
  };
};

export type SaveSessionMetadataInput = Omit<
  Partial<SessionMetadata>,
  "version" | "sessionId" | "projectPath" | "createdAt" | "updatedAt" | "runIds" | "currentRunId"
>;

export class SessionStore {
  constructor(private readonly storage: ProjectStorageContext | string) {}

  sessionDir(sessionId: string): string {
    return sessionDirectory(this.storage, sessionId);
  }

  async appendTranscript(sessionId: string, message: ModelMessage, runId?: string): Promise<void> {
    const transcriptPath = join(this.sessionDir(sessionId), "transcript.jsonl");
    await appendJsonLine(transcriptPath, {
      ts: new Date().toISOString(),
      message,
      ...(runId ? { runId } : {})
    } satisfies TranscriptEntry);
    await this.touch(sessionId);
  }

  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    try {
      const text = await readFile(join(this.sessionDir(sessionId), "transcript.jsonl"), "utf8");
      if (!text.trim()) return [];
      return text.trim().split("\n").map((line) => JSON.parse(line) as TranscriptEntry);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  }

  async saveMetadata(sessionId: string, input: SaveSessionMetadataInput): Promise<SessionMetadata> {
    return this.updateMetadata(sessionId, (metadata) => ({ ...metadata, ...input }));
  }

  async loadMetadata(sessionId: string): Promise<SessionMetadata | undefined> {
    const metadata = await readJsonWithBackup<SessionMetadata>(join(this.sessionDir(sessionId), "session.json"));
    if (!metadata) return undefined;
    assertSessionMetadata(metadata, sessionId);
    return metadata;
  }

  async listSessions(options: { limit?: number } = {}): Promise<SessionMetadata[]> {
    let entries;
    try {
      entries = await readdir(projectDirectory(this.storage), { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const sessions = (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== ".lease-history")
      .map((entry) => this.loadMetadata(entry.name).catch(() => undefined))))
      .filter((entry): entry is SessionMetadata => Boolean(entry))
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || right.sessionId.localeCompare(left.sessionId));
    return sessions.slice(0, options.limit ?? sessions.length);
  }

  async attachRun(sessionId: string, runId: string): Promise<SessionMetadata> {
    return this.updateMetadata(sessionId, (metadata) => ({
      ...metadata,
      currentRunId: runId,
      runIds: metadata.runIds.includes(runId) ? metadata.runIds : [...metadata.runIds, runId]
    }));
  }

  async savePlanState(sessionId: string, plan: PlanSessionState): Promise<SessionMetadata> {
    return this.saveMetadata(sessionId, { plan });
  }

  async loadPlanState(sessionId: string): Promise<PlanSessionState | undefined> {
    return (await this.loadMetadata(sessionId))?.plan;
  }

  async recordUsage(sessionId: string, usage: ModelUsage): Promise<SessionMetadata> {
    return this.updateMetadata(sessionId, (metadata) => ({
      ...metadata,
      usage: addModelUsage(metadata.usage, usage)
    }));
  }

  async touch(sessionId: string): Promise<SessionMetadata> {
    return this.updateMetadata(sessionId, (metadata) => metadata);
  }

  private async updateMetadata(
    sessionId: string,
    update: (metadata: SessionMetadata) => SessionMetadata
  ): Promise<SessionMetadata> {
    const path = join(this.sessionDir(sessionId), "session.json");
    return updateJsonAtomic<SessionMetadata>(path, (current) => {
      const now = new Date().toISOString();
      const base: SessionMetadata = current ?? {
        version: 1,
        sessionId,
        projectPath: projectPath(this.storage),
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        runIds: []
      };
      assertSessionMetadata(base, sessionId);
      const next = update(base);
      return {
        ...next,
        version: 1,
        sessionId,
        projectPath: base.projectPath,
        createdAt: base.createdAt,
        updatedAt: now,
        lastActivityAt: now,
        runIds: next.runIds.slice()
      };
    });
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lease = await acquireFileLease(`${path}.lease`, `Transcript ${path}`, { wait: true });
  try {
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await lease.release();
  }
}

function assertSessionMetadata(metadata: SessionMetadata, sessionId: string): void {
  if (metadata.version !== 1 || metadata.sessionId !== sessionId || !Array.isArray(metadata.runIds)) {
    throw new Error(`Invalid session metadata for ${sessionId}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

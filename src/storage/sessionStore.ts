import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelMessage } from "../providers/types.js";
import { PlanSessionState } from "../plans/planSession.js";
import { addModelUsage, ModelUsage, ModelUsageTotals } from "../model/usage.js";
import type { PromptInjectionRecord } from "../runtime/types.js";
import { readJsonWithBackup, updateJsonAtomic } from "./atomicJson.js";
import { acquireFileLease } from "./fileLease.js";
import { projectDirectory, projectPath, ProjectStorageContext, sessionDirectory } from "./projectStorage.js";
import { AuditStore } from "../audit/auditStore.js";
import type { AuditEvent } from "../audit/auditEvent.js";
import type { BusDirectiveSelectedEvent, SessionBusCheckpoint } from "../runtime/busTypes.js";
import { kernelSessionCheckpoint, restoreKernelSession as restoreKernelSessionFromCheckpoint, type KernelSession, type KernelSessionCheckpoint } from "../kernel/session.js";

export type TranscriptPhase = "bus" | "plan" | "workflow";

export type TranscriptEntry = {
  ts: string;
  message: ModelMessage;
  runId?: string;
  phase?: TranscriptPhase;
  entryId?: string;
};

export type WorkflowTranscriptEntryInput = {
  ts?: string;
  message: ModelMessage;
  runId: string;
  entryId: string;
};

export type BusRoutingEntry = {
  ts: string;
  event: BusDirectiveSelectedEvent;
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
  bus?: SessionBusCheckpoint;
  execution?: KernelSessionCheckpoint;
  usage?: ModelUsageTotals;
  modelRequestCount?: number;
  promptInjection?: {
    globalPrompt?: PromptInjectionRecord;
  };
};

export type SaveSessionMetadataInput = Omit<
  Partial<SessionMetadata>,
  "version" | "sessionId" | "projectPath" | "createdAt" | "updatedAt" | "runIds" | "currentRunId"
>;

export type ArchivedSession = {
  sessionId: string;
  archivePath: string;
};

const transcriptIndexes = new Map<string, { size: number; entryIds: Set<string> }>();
const lastSessionTouches = new Map<string, number>();
const sessionTouchIntervalMs = 1_000;

export class SessionStore {
  constructor(private readonly storage: ProjectStorageContext | string) {}

  sessionDir(sessionId: string): string {
    return sessionDirectory(this.storage, sessionId);
  }

  async appendTranscript(sessionId: string, message: ModelMessage, runId?: string): Promise<void> {
    const transcriptPath = join(this.sessionDir(sessionId), "transcript.jsonl");
    await appendJsonLines(transcriptPath, [{
      ts: new Date().toISOString(),
      message,
      phase: "plan",
      ...(runId ? { runId } : {})
    } satisfies TranscriptEntry]);
    await this.touch(sessionId);
  }

  async appendBusTranscript(sessionId: string, message: ModelMessage, runId?: string): Promise<void> {
    const transcriptPath = join(this.sessionDir(sessionId), "transcript.jsonl");
    await appendJsonLines(transcriptPath, [{
      ts: new Date().toISOString(),
      message,
      phase: "bus",
      ...(runId ? { runId } : {})
    } satisfies TranscriptEntry]);
    const preview = message.role === "user"
      ? (typeof message.content === "string"
          ? message.content
          : message.content.find((part) => part.type === "text")?.text)?.trim()
      : undefined;
    await this.updateMetadata(sessionId, (metadata) => (
      preview && !metadata.inputPreview
        ? { ...metadata, inputPreview: preview.slice(0, 200) }
        : metadata
    ));
  }

  async loadBusTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    return (await this.loadTranscript(sessionId)).filter((entry) => entry.phase === "bus");
  }

  async appendBusRoutingEvent(sessionId: string, event: BusDirectiveSelectedEvent): Promise<void> {
    await appendJsonLines(join(this.sessionDir(sessionId), "bus-routing.jsonl"), [{
      ts: new Date().toISOString(),
      event
    } satisfies BusRoutingEntry]);
    await this.touch(sessionId);
  }

  async loadBusRoutingEvents(sessionId: string): Promise<BusRoutingEntry[]> {
    try {
      const text = await readFile(join(this.sessionDir(sessionId), "bus-routing.jsonl"), "utf8");
      if (!text.trim()) return [];
      const entries: BusRoutingEntry[] = [];
      for (const line of text.trim().split("\n")) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as BusRoutingEntry);
        } catch {
          continue;
        }
      }
      return entries;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  }

  async saveBusState(sessionId: string, bus: SessionBusCheckpoint): Promise<SessionMetadata> {
    return this.saveMetadata(sessionId, { bus });
  }

  async loadBusState(sessionId: string): Promise<SessionBusCheckpoint | undefined> {
    return (await this.loadMetadata(sessionId))?.bus;
  }

  async appendAudit(sessionId: string, event: AuditEvent): Promise<void> {
    await new AuditStore(this.sessionDir(sessionId)).append({ ...event, session_id: event.session_id ?? sessionId });
    await this.touch(sessionId);
  }

  async appendWorkflowTranscriptEntries(sessionId: string, entries: WorkflowTranscriptEntryInput[]): Promise<void> {
    if (!entries.length) return;
    const transcriptPath = join(this.sessionDir(sessionId), "transcript.jsonl");
    const appended = await appendJsonLines(transcriptPath, entries.map((entry) => ({
      ts: entry.ts ?? new Date().toISOString(),
      message: entry.message,
      runId: entry.runId,
      phase: "workflow" as const,
      entryId: entry.entryId
    })), true);
    if (appended) await this.touch(sessionId);
  }

  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    try {
      const text = await readFile(join(this.sessionDir(sessionId), "transcript.jsonl"), "utf8");
      if (!text.trim()) return [];
      // Skip torn lines left by a crash mid-append rather than discarding the whole transcript.
      const entries: TranscriptEntry[] = [];
      for (const line of text.trim().split("\n")) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as TranscriptEntry);
        } catch {
          continue;
        }
      }
      return entries;
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
      .filter((entry) => entry.isDirectory() && entry.name !== ".lease-history" && entry.name !== ".trash")
      .map((entry) => this.loadMetadata(entry.name).catch(() => undefined))))
      .filter((entry): entry is SessionMetadata => Boolean(entry))
      .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || right.sessionId.localeCompare(left.sessionId));
    return sessions.slice(0, options.limit ?? sessions.length);
  }

  async archiveSession(sessionId: string): Promise<ArchivedSession> {
    const sourcePath = this.sessionDir(sessionId);
    const metadata = await this.loadMetadata(sessionId);
    if (!metadata) throw new Error(`Session ${sessionId} was not found`);

    const archiveDir = join(projectDirectory(this.storage), ".trash", "sessions");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(archiveDir, `${sessionId}-${timestamp}-${randomUUID()}`);
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    await rename(sourcePath, archivePath);

    transcriptIndexes.delete(join(sourcePath, "transcript.jsonl"));
    lastSessionTouches.delete(sourcePath);
    return { sessionId, archivePath };
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

  async saveKernelCheckpoint(session: KernelSession): Promise<SessionMetadata> {
    return this.saveMetadata(session.id, {
      ...(session.planState ? { plan: session.planState } : {}),
      execution: kernelSessionCheckpoint(session)
    });
  }

  async syncWorkflowRunStatus(
    sessionId: string,
    runId: string,
    status: "running" | "completed"
  ): Promise<SessionMetadata | undefined> {
    const current = await this.loadMetadata(sessionId);
    if (!current || current.currentRunId !== runId) return current;
    if (!current.execution?.workflowBinding) {
      return this.touch(sessionId, { force: status === "completed" });
    }
    if (current.execution.workflowBinding.runId !== runId) return current;

    const sessionStatus = status === "completed" ? "idle_input" : "running_workflow";
    if (
      current.execution.status === sessionStatus
      && current.execution.workflowBinding.status === status
      && current.execution.pendingInteraction === null
    ) {
      return current;
    }

    return this.updateMetadata(sessionId, (metadata) => {
      const execution = metadata.execution;
      if (
        metadata.currentRunId !== runId
        || !execution?.workflowBinding
        || execution.workflowBinding.runId !== runId
      ) {
        return metadata;
      }
      return {
        ...metadata,
        execution: {
          ...execution,
          status: sessionStatus,
          workflowBinding: {
            ...execution.workflowBinding,
            status
          },
          pendingInteraction: null
        }
      };
    });
  }

  async restoreKernelSession(sessionId: string, cwd: string): Promise<KernelSession | undefined> {
    const metadata = await this.loadMetadata(sessionId);
    if (!metadata?.execution) return undefined;
    return restoreKernelSessionFromCheckpoint({ id: sessionId, cwd, checkpoint: metadata.execution });
  }

  async recordUsage(sessionId: string, usage: ModelUsage): Promise<SessionMetadata> {
    return this.updateMetadata(sessionId, (metadata) => ({
      ...metadata,
      usage: addModelUsage(metadata.usage, usage)
    }));
  }

  async recordModelResponse(sessionId: string, usage?: ModelUsage): Promise<SessionMetadata> {
    return this.updateMetadata(sessionId, (metadata) => ({
      ...metadata,
      modelRequestCount: (metadata.modelRequestCount ?? 0) + 1,
      ...(usage ? { usage: addModelUsage(metadata.usage, usage) } : {})
    }));
  }

  async touch(sessionId: string, options: { force?: boolean } = {}): Promise<SessionMetadata> {
    const key = this.sessionDir(sessionId);
    const now = Date.now();
    const previous = lastSessionTouches.get(key) ?? 0;
    if (!options.force && now - previous < sessionTouchIntervalMs) {
      const current = await this.loadMetadata(sessionId);
      if (current) return current;
    }
    const metadata = await this.updateMetadata(sessionId, (current) => current);
    lastSessionTouches.set(key, now);
    return metadata;
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

async function appendJsonLines<T extends object>(path: string, values: T[], deduplicate = false): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lease = await acquireFileLease(`${path}.lease`, `Transcript ${path}`, { wait: true });
  try {
    const currentSize = await stat(path).then((info) => info.size).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return 0;
      throw error;
    });
    let index = transcriptIndexes.get(path);
    if (!index || index.size !== currentSize) {
      const existing = currentSize > 0 ? await readFile(path, "utf8") : "";
      index = {
        size: currentSize,
        entryIds: new Set(existing.trim()
          ? existing.trim().split("\n").map((line) => (JSON.parse(line) as { entryId?: string }).entryId).filter((entryId): entryId is string => Boolean(entryId))
          : [])
      };
      transcriptIndexes.set(path, index);
    }
    const pending = deduplicate
      ? values.filter((entry) => {
          const entryId = (entry as { entryId?: string }).entryId;
          return !entryId || !index!.entryIds.has(entryId);
        })
      : values;
    if (!pending.length) return false;
    const content = pending.map((value) => `${JSON.stringify(value)}\n`).join("");
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    index.size += Buffer.byteLength(content, "utf8");
    for (const entry of pending) {
      const entryId = (entry as { entryId?: string }).entryId;
      if (entryId) index.entryIds.add(entryId);
    }
    return true;
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

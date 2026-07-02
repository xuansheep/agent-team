import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelMessage } from "../providers/types.js";
import { getPlanSlug } from "../plans/planFiles.js";
import { PlanSessionState } from "../plans/planSession.js";
import { addModelUsage, ModelUsage, ModelUsageTotals } from "../model/usage.js";
import { SessionIndex } from "./sessionIndex.js";

export type TranscriptEntry = {
  ts: string;
  message: ModelMessage;
};

export type SessionMetadata = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status?: "planning" | "waiting_approval" | "running" | "pending" | "completed";
  workflowRunId?: string;
  plan?: PlanSessionState;
  usage?: ModelUsageTotals;
};

export type SaveSessionMetadataInput = Omit<Partial<SessionMetadata>, "sessionId" | "createdAt" | "updatedAt">;

export class SessionStore {
  private readonly metadataWriteQueues = new Map<string, Promise<SessionMetadata>>();

  constructor(private readonly rootDir = ".session") {}

  sessionDir(sessionId: string): string {
    return join(this.rootDir, "sessions", getPlanSlug(sessionId));
  }

  async appendTranscript(sessionId: string, message: ModelMessage): Promise<void> {
    const transcriptPath = join(this.sessionDir(sessionId), "transcript.jsonl");
    await mkdir(dirname(transcriptPath), { recursive: true });
    const entry: TranscriptEntry = { ts: new Date().toISOString(), message };
    await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
    await this.saveMetadata(sessionId, {});
  }

  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    try {
      const text = await readFile(join(this.sessionDir(sessionId), "transcript.jsonl"), "utf8");
      return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as TranscriptEntry) : [];
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  }

  async saveMetadata(sessionId: string, input: SaveSessionMetadataInput): Promise<SessionMetadata> {
    const previous = this.metadataWriteQueues.get(sessionId) ?? Promise.resolve(undefined as unknown as SessionMetadata);
    const next = previous.catch(() => undefined).then(() => this.writeMetadata(sessionId, input));
    this.metadataWriteQueues.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.metadataWriteQueues.get(sessionId) === next) this.metadataWriteQueues.delete(sessionId);
    }
  }

  private async writeMetadata(sessionId: string, input: SaveSessionMetadataInput): Promise<SessionMetadata> {
    const now = new Date().toISOString();
    const existing = await this.loadMetadata(sessionId);
    const metadata: SessionMetadata = {
      sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...existing,
      ...input
    };
    const metadataPath = join(this.sessionDir(sessionId), "metadata.json");
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await new SessionIndex(this.rootDir).upsert({
      sessionId,
      metadataPath,
      updatedAt: metadata.updatedAt,
      ...(metadata.status ? { status: metadata.status } : {}),
      ...(metadata.workflowRunId ? { workflowRunId: metadata.workflowRunId } : {})
    });
    return metadata;
  }

  async loadMetadata(sessionId: string): Promise<SessionMetadata | undefined> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(sessionId), "metadata.json"), "utf8")) as SessionMetadata;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async savePlanState(sessionId: string, plan: PlanSessionState): Promise<SessionMetadata> {
    return this.saveMetadata(sessionId, { status: plan.mode === "inactive" ? "completed" : plan.mode, plan });
  }

  async loadPlanState(sessionId: string): Promise<PlanSessionState | undefined> {
    return (await this.loadMetadata(sessionId))?.plan;
  }

  async recordUsage(sessionId: string, usage: ModelUsage): Promise<SessionMetadata> {
    const existing = await this.loadMetadata(sessionId);
    return this.saveMetadata(sessionId, { usage: addModelUsage(existing?.usage, usage) });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

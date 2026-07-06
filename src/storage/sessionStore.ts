import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ModelMessage } from "../providers/types.js";
import { PlanSessionState } from "../plans/planSession.js";
import { addModelUsage, ModelUsage, ModelUsageTotals } from "../model/usage.js";
import { readRootIndex, SessionIndex } from "./sessionIndex.js";
import { cachedSessionDir, createSessionDir, rememberSessionDir, sessionDirFromPlanFilePath } from "./sessionPaths.js";
import type { PromptInjectionRecord } from "../runtime/types.js";

export type TranscriptEntry = {
  ts: string;
  message: ModelMessage;
};

export type SessionMetadata = {
  sessionId: string;
  sessionDir?: string;
  createdAt: string;
  updatedAt: string;
  status?: "planning" | "waiting_approval" | "running" | "pending" | "completed";
  runId?: string;
  workflowRunId?: string;
  workflowId?: string;
  plan?: PlanSessionState;
  usage?: ModelUsageTotals;
  promptInjection?: {
    globalPrompt?: PromptInjectionRecord;
  };
};

export type SaveSessionMetadataInput = Omit<Partial<SessionMetadata>, "sessionId" | "createdAt" | "updatedAt" | "sessionDir">;

export class SessionStore {
  private readonly metadataWriteQueues = new Map<string, Promise<SessionMetadata>>();

  constructor(private readonly rootDir = ".session") {}

  sessionDir(sessionId: string): string {
    return cachedSessionDir(this.rootDir, sessionId) ?? createSessionDir(this.rootDir, sessionId);
  }

  async appendTranscript(sessionId: string, message: ModelMessage): Promise<void> {
    const sessionDir = await this.resolveSessionDir(sessionId);
    const transcriptPath = join(sessionDir, "transcript.jsonl");
    await mkdir(dirname(transcriptPath), { recursive: true });
    const entry: TranscriptEntry = { ts: new Date().toISOString(), message };
    await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
    await this.saveMetadata(sessionId, {});
  }

  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const sessionDir = await this.findExistingSessionDir(sessionId);
    if (!sessionDir) return [];
    try {
      const text = await readFile(join(sessionDir, "transcript.jsonl"), "utf8");
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
    const sessionDir = await this.resolveSessionDir(sessionId, input);
    const existing = await this.loadMetadataFromDir(sessionDir);
    const metadata: SessionMetadata = {
      ...existing,
      sessionId,
      sessionDir,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...input
    };
    const metadataPath = join(sessionDir, "metadata.json");
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await new SessionIndex(this.rootDir).upsert({
      sessionId,
      sessionDir,
      metadataPath,
      updatedAt: metadata.updatedAt,
      ...(metadata.status ? { status: metadata.status } : {}),
      ...(metadata.workflowRunId ? { workflowRunId: metadata.workflowRunId } : {})
    });
    return metadata;
  }

  async loadMetadata(sessionId: string): Promise<SessionMetadata | undefined> {
    const sessionDir = await this.findExistingSessionDir(sessionId);
    return sessionDir ? this.loadMetadataFromDir(sessionDir) : undefined;
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

  private async resolveSessionDir(sessionId: string, input?: SaveSessionMetadataInput): Promise<string> {
    const planFilePath = input?.plan?.planFilePath;
    if (typeof planFilePath === "string" && planFilePath.trim()) {
      const sessionDir = sessionDirFromPlanFilePath(planFilePath);
      rememberSessionDir(this.rootDir, sessionId, sessionDir);
      return sessionDir;
    }
    const existing = await this.findExistingSessionDir(sessionId);
    if (existing) return existing;
    return createSessionDir(this.rootDir, sessionId);
  }

  private async findExistingSessionDir(sessionId: string): Promise<string | undefined> {
    const cached = cachedSessionDir(this.rootDir, sessionId);
    if (cached) return cached;
    const index = await readRootIndex(this.rootDir).catch(() => undefined);
    const session = index?.sessions?.find((entry) => entry.sessionId === sessionId);
    if (session?.sessionDir) {
      rememberSessionDir(this.rootDir, sessionId, session.sessionDir);
      return session.sessionDir;
    }
    const runSession = index?.sessions?.find((entry) => entry.workflowRunId === sessionId);
    if (runSession?.sessionDir) {
      rememberSessionDir(this.rootDir, runSession.sessionId, runSession.sessionDir);
      return runSession.sessionDir;
    }
    const run = index?.runs?.find((entry) => entry.runId === sessionId);
    if (run?.runDir) return run.runDir;
    return undefined;
  }

  private async loadMetadataFromDir(sessionDir: string): Promise<SessionMetadata | undefined> {
    const metadataPath = join(sessionDir, "metadata.json");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const text = await readFile(metadataPath, "utf8");
        if (!text.trim()) throw new SyntaxError("Empty metadata");
        const metadata = JSON.parse(text) as SessionMetadata;
        if (metadata.sessionId) rememberSessionDir(this.rootDir, metadata.sessionId, sessionDir);
        return metadata;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return undefined;
        if (error instanceof SyntaxError && attempt < 4) {
          await delay(10);
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

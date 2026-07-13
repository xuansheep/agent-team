import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessEvent, StoredEvent } from "../harness/events.js";
import { WorkflowState } from "../workflow/state.js";
import { IndexedRunSummary, readRootIndex, SessionIndex, writeRootIndex } from "./sessionIndex.js";
import { createSessionDir, rememberSessionDir } from "./sessionPaths.js";
import { acquireFileLease, FileLease } from "./fileLease.js";

export type RunSummary = {
  runId: string;
  runDir: string;
  workflowId: string;
  status: WorkflowState["status"];
  currentNodeId?: string;
  startedAt?: string;
  updatedAt: string;
  inputPreview: string;
};

export type CreateRunOptions = {
  sessionId?: string;
  sessionDir?: string;
  runId?: string;
};

export class RunStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly leaseQueues = new Map<string, Promise<unknown>>();
  private readonly heldRunLeases = new Map<string, { lease: FileLease; references: number }>();
  private readonly runDirs = new Map<string, string>();
  /** Tracks the next event sequence number per runId to avoid re-reading the file on every append. */
  private readonly nextSeq = new Map<string, number>();

  constructor(private readonly rootDir = ".session") {}

  async createRun(workflowId: string, input: unknown, options: CreateRunOptions = {}): Promise<{ runId: string; runDir: string }> {
    const generatedRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const runId = options.runId ?? generatedRunId;
    const sessionId = options.sessionId ?? runId;
    const runDir = options.sessionDir ?? createSessionDir(this.rootDir, sessionId);
    this.runDirs.set(runId, runDir);
    rememberSessionDir(this.rootDir, sessionId, runDir);
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "events.ndjson"), "", "utf8");
    this.nextSeq.set(runId, 1);
    await this.writeRunMetadata({ sessionId, runId, runDir, workflowId, status: "running" });
    await this.appendEvent(runId, { type: "run_started", workflow_id: workflowId, input });
    return { runId, runDir };
  }

  runDir(runId: string): string {
    const cached = this.runDirs.get(runId);
    if (cached) return cached;
    const runDir = createSessionDir(this.rootDir, runId);
    this.runDirs.set(runId, runDir);
    return runDir;
  }

  async appendEvent(runId: string, event: HarnessEvent): Promise<StoredEvent> {
    return this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const eventsPath = join(runDir, "events.ndjson");
      const seq = await this.resolveNextSeq(runId, eventsPath);
      const stored: StoredEvent = { ...event, ts: new Date().toISOString(), seq };
      this.nextSeq.set(runId, seq + 1);
      const line = `${JSON.stringify(stored)}\n`;
      if (event.type === "tool_invoked" || event.type === "tool_completed" || event.type === "tool_failed") {
        const handle = await open(eventsPath, "a");
        try {
          await handle.writeFile(line, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        await appendFile(eventsPath, line, "utf8");
      }
      return stored;
    });
  }

  async loadEvents(runId: string): Promise<StoredEvent[]> {
    const runDir = await this.resolveRunDir(runId);
    const text = await readFile(join(runDir, "events.ndjson"), "utf8");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as StoredEvent) : [];
  }

  async saveState(runId: string, state: WorkflowState): Promise<void> {
    await this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      try {
        const current = await readFile(join(runDir, "state.json"), "utf8");
        JSON.parse(current);
        await writeFile(join(runDir, "state.backup.json"), current, "utf8");
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
      }
      await writeFile(join(runDir, "state.json"), serialized, "utf8");
    });
    await this.updateRunIndex(runId);
  }

  async acquireRunLease(runId: string): Promise<FileLease> {
    return this.enqueueLeaseOperation(runId, async () => {
      const held = this.heldRunLeases.get(runId);
      if (held) {
        held.references += 1;
        return this.runLeaseReference(runId);
      }
      const runDir = await this.resolveRunDir(runId);
      const lease = await acquireFileLease(join(runDir, "run.lease"), `Run ${runId}`);
      this.heldRunLeases.set(runId, { lease, references: 1 });
      return this.runLeaseReference(runId);
    });
  }

  async markInterrupted(runId: string, state: WorkflowState): Promise<void> {
    await this.appendEvent(runId, { type: "run_interrupted", reason: "user" });
    await this.saveState(runId, state);
  }

  async loadState(runId: string): Promise<WorkflowState> {
    const runDir = await this.resolveRunDir(runId);
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const name of ["state.json", "state.backup.json"]) {
        try {
          const parsed = JSON.parse(await readFile(join(runDir, name), "utf8")) as WorkflowState;
          if (parsed.version !== 2) throw new Error(`Unsupported workflow state version ${String((parsed as { version?: unknown }).version ?? "legacy")}; start a new run`);
          return parsed;
        } catch (error) {
          lastError = error;
          if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
        }
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw lastError;
  }

  async listRuns(options: { limit?: number } = {}): Promise<RunSummary[]> {
    const indexed = await this.listIndexedRuns(options);
    if (indexed) return indexed;

    const runDirs = await this.scanRunDirs();
    const runs: RunSummary[] = [];
    for (const runDir of runDirs) {
      try {
        const metadata = await readMetadata(runDir);
        const runId = typeof metadata?.runId === "string" ? metadata.runId : typeof metadata?.workflowRunId === "string" ? metadata.workflowRunId : undefined;
        if (!runId) continue;
        this.runDirs.set(runId, runDir);
        runs.push(await this.buildRunSummary(runId));
      } catch {
        // Ignore partially-written or manually-corrupted run directories.
      }
    }

    const limit = options.limit ?? runs.length;
    return runs
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.runId.localeCompare(a.runId))
      .slice(0, limit);
  }

  private async listIndexedRuns(options: { limit?: number }): Promise<RunSummary[] | undefined> {
    const index = await readRootIndex(this.rootDir).catch(() => undefined);
    if (!index?.runs?.length) return undefined;
    const limit = options.limit ?? index.runs.length;
    return index.runs
      .map((run) => ({
        runId: run.runId,
        runDir: run.runDir,
        workflowId: run.workflowId,
        status: run.status as WorkflowState["status"],
        currentNodeId: run.currentNodeId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        inputPreview: run.inputPreview
      }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.runId.localeCompare(a.runId))
      .slice(0, limit);
  }

  private async updateRunIndex(runId: string): Promise<void> {
    const summary = await this.buildRunSummary(runId);
    const index = await readRootIndex(this.rootDir).catch(() => undefined) ?? { version: 1 as const };
    const runs: IndexedRunSummary[] = [...index.runs ?? []].filter((run) => run.runId !== runId);
    runs.push(summary);
    runs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.runId.localeCompare(a.runId));
    await writeRootIndex(this.rootDir, { ...index, runs });
  }

  private async buildRunSummary(runId: string): Promise<RunSummary> {
    const runDir = await this.resolveRunDir(runId);
    const state = await this.loadState(runId);
    const events = await this.loadEvents(runId).catch(() => [] as StoredEvent[]);
    const started = events.find((event) => event.type === "run_started");
    const latest = events.at(-1);
    const stateStat = await stat(join(runDir, "state.json"));
    return {
      runId,
      runDir,
      workflowId: state.workflow_id,
      status: state.status,
      currentNodeId: state.current_node_id,
      startedAt: started?.ts,
      updatedAt: latest?.ts ?? stateStat.mtime.toISOString(),
      inputPreview: inputPreview(started && "input" in started ? started.input : undefined)
    };
  }

  private async resolveRunDir(runId: string): Promise<string> {
    const cached = this.runDirs.get(runId);
    if (cached) return cached;
    const index = await readRootIndex(this.rootDir).catch(() => undefined);
    const indexedRun = index?.runs?.find((entry) => entry.runId === runId);
    if (indexedRun?.runDir) {
      this.runDirs.set(runId, indexedRun.runDir);
      return indexedRun.runDir;
    }
    const indexedSession = index?.sessions?.find((entry) => entry.workflowRunId === runId || entry.sessionId === runId);
    if (indexedSession?.sessionDir) {
      this.runDirs.set(runId, indexedSession.sessionDir);
      return indexedSession.sessionDir;
    }
    return this.runDir(runId);
  }

  private async writeRunMetadata(input: { sessionId: string; runId: string; runDir: string; workflowId: string; status: string }): Promise<void> {
    const now = new Date().toISOString();
    const metadataPath = join(input.runDir, "metadata.json");
    const existing = await readMetadata(input.runDir);
    const metadata = {
      ...existing,
      sessionId: typeof existing?.sessionId === "string" ? existing.sessionId : input.sessionId,
      sessionDir: input.runDir,
      createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
      updatedAt: now,
      status: input.status,
      runId: input.runId,
      workflowRunId: input.runId,
      workflowId: input.workflowId
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await new SessionIndex(this.rootDir).upsert({
      sessionId: metadata.sessionId,
      sessionDir: input.runDir,
      metadataPath,
      updatedAt: metadata.updatedAt,
      status: metadata.status,
      workflowRunId: input.runId
    });
  }

  private async scanRunDirs(): Promise<string[]> {
    let months;
    try {
      months = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const runDirs: string[] = [];
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{6}$/.test(month.name)) continue;
      const monthDir = join(this.rootDir, month.name);
      const sessions = await readdir(monthDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      });
      for (const session of sessions) {
        if (session.isDirectory()) runDirs.push(join(monthDir, session.name));
      }
    }
    return runDirs;
  }

  /**
   * Resolves the next sequence number for a run.
   * Uses the in-memory cache if available; otherwise reads the last line
   * of the events.ndjson file to compute the next seq.
   */
  private async resolveNextSeq(runId: string, eventsPath: string): Promise<number> {
    const cached = this.nextSeq.get(runId);
    if (cached !== undefined) return cached;

    try {
      const text = await readFile(eventsPath, "utf8");
      const trimmed = text.trim();
      if (!trimmed) {
        this.nextSeq.set(runId, 1);
        return 1;
      }
      const lines = trimmed.split("\n");
      this.nextSeq.set(runId, lines.length + 1);
      return lines.length + 1;
    } catch {
      this.nextSeq.set(runId, 1);
      return 1;
    }
  }

  private enqueueRunWrite<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.writeQueues.set(runId, next.catch(() => undefined));
    return next;
  }

  private runLeaseReference(runId: string): FileLease {
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.enqueueLeaseOperation(runId, async () => {
          const held = this.heldRunLeases.get(runId);
          if (!held) return;
          held.references -= 1;
          if (held.references > 0) return;
          this.heldRunLeases.delete(runId);
          await held.lease.release();
        });
      }
    };
  }

  private enqueueLeaseOperation<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.leaseQueues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.leaseQueues.set(runId, next.catch(() => undefined));
    return next;
  }
}

async function readMetadata(runDir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (isErrno(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function inputPreview(input: unknown): string {
  let text = "";
  if (typeof input === "string") text = input;
  else if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    if (typeof value.request === "string") text = value.request;
    else if (typeof value.answer === "string") text = value.answer;
    else text = JSON.stringify(value);
  } else if (input !== undefined) text = String(input);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

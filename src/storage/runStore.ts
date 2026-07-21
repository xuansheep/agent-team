import { appendFile, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessEvent, StoredEvent } from "../harness/events.js";
import { ModelMessage } from "../providers/types.js";
import { WorkflowState } from "../workflow/state.js";
import { readJsonWithBackup, updateJsonAtomic, writeJsonAtomic } from "./atomicJson.js";
import { projectDirectory, ProjectStorageContext, runDirectory } from "./projectStorage.js";
import { acquireFileLease, FileLease } from "./fileLease.js";
import { AuditStore } from "../audit/auditStore.js";
import type { AuditEvent } from "../audit/auditEvent.js";
import { isDestructiveShellCommand } from "../security/shellSafety.js";
import { SessionStore } from "./sessionStore.js";

export type RunMetadata = {
  version: 1;
  runId: string;
  sessionId: string;
  workflowId: string;
  createdAt: string;
  trigger: "initial" | "follow_up" | "retry" | "manual";
  parentRunId?: string;
  configFingerprint?: string;
  permissionMode?: string;
  initialInputPreview?: string;
};

export type RunSummary = {
  runId: string;
  sessionId: string;
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
  runId?: string;
  trigger?: RunMetadata["trigger"];
  parentRunId?: string;
  configFingerprint?: string;
  permissionMode?: string;
};

export class RunStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly leaseQueues = new Map<string, Promise<unknown>>();
  private readonly heldRunLeases = new Map<string, { lease: FileLease; references: number }>();
  private readonly runDirs = new Map<string, string>();
  private readonly runSessions = new Map<string, string>();
  private readonly nextSeq = new Map<string, number>();
  private readonly dialogueCounts = new Map<string, number>();
  private readonly pendingPermissions = new Map<string, { tool: string; nodeId: string; attempt: number; rule?: string }>();
  private readonly sessionStore: SessionStore;

  constructor(private readonly storage: ProjectStorageContext | string) {
    this.sessionStore = new SessionStore(storage);
  }

  async createRun(workflowId: string, input: unknown, options: CreateRunOptions = {}): Promise<{ sessionId: string; runId: string; runDir: string }> {
    const generatedRunId = randomUUID();
    const runId = options.runId ?? generatedRunId;
    const sessionId = options.sessionId ?? runId;
    const runDir = runDirectory(this.storage, sessionId, runId);
    this.rememberRun(runId, sessionId, runDir);

    await mkdir(join(runDir, "artifacts"), { recursive: true, mode: 0o700 });
    const eventHandle = await open(join(runDir, "events.ndjson"), "wx", 0o600);
    await eventHandle.close();
    this.nextSeq.set(runId, 1);

    const metadata: RunMetadata = {
      version: 1,
      runId,
      sessionId,
      workflowId,
      createdAt: new Date().toISOString(),
      trigger: options.trigger ?? "initial",
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.configFingerprint ? { configFingerprint: options.configFingerprint } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(inputPreview(input) ? { initialInputPreview: inputPreview(input) } : {})
    };
    await writeJsonAtomic(join(runDir, "run.json"), metadata, { backupPath: false });
    await writeJsonAtomic(join(runDir, "run.backup.json"), metadata, { backupPath: false });
    await this.sessionStore.attachRun(sessionId, runId);
    await this.appendEvent(runId, { type: "run_started", workflow_id: workflowId, input });
    return { sessionId, runId, runDir };
  }

  runDir(runId: string): string {
    const cached = this.runDirs.get(runId);
    if (cached) return cached;
    const fallback = runDirectory(this.storage, runId, runId);
    this.rememberRun(runId, runId, fallback);
    return fallback;
  }

  async metadata(runId: string): Promise<RunMetadata> {
    const runDir = await this.resolveRunDir(runId);
    const metadata = await readJsonWithBackup<RunMetadata>(join(runDir, "run.json"));
    if (!metadata || metadata.version !== 1 || metadata.runId !== runId) {
      throw new Error(`Invalid run metadata for ${runId}`);
    }
    this.rememberRun(runId, metadata.sessionId, runDir);
    return metadata;
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
      if (isAuditableEvent(event)) await this.appendAuditRecords(runId, runDir, event);
      await this.recordSessionEvent(runId, event, stored);
      return stored;
    });
  }

  async syncWorkflowDialogue(runId: string, nodeId: string, attempt: number, messages: ModelMessage[]): Promise<number> {
    return this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const path = dialogueJournalPath(runDir, nodeId, attempt);
      const key = `${runId}:${nodeId}:${attempt}`;
      let count = this.dialogueCounts.get(key);
      if (count === undefined) {
        count = (await readDialogueJournal(path)).length;
        this.dialogueCounts.set(key, count);
      }
      if (messages.length < count) {
        throw new Error(`Dialogue for ${nodeId} attempt ${attempt} moved backward from ${count} to ${messages.length} messages`);
      }
      const pending = messages.slice(count);
      if (!pending.length) return count;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const content = pending.map((message) => `${JSON.stringify(message)}\n`).join("");
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const previousCount = count;
      count += pending.length;
      this.dialogueCounts.set(key, count);
      const sessionId = this.runSessions.get(runId) ?? (await this.metadata(runId)).sessionId;
      const entries = pending.flatMap((message, index) =>
        message.role === "assistant" || message.role === "tool"
          ? [{ message, runId, entryId: `workflow:${runId}:node:${nodeId}:attempt:${attempt}:message:${previousCount + index}` }]
          : []
      );
      await this.sessionStore.appendWorkflowTranscriptEntries(sessionId, entries);
      return count;
    });
  }

  async loadWorkflowDialogue(runId: string, nodeId: string, attempt: number, cursor?: number): Promise<ModelMessage[]> {
    const runDir = await this.resolveRunDir(runId);
    const messages = await readDialogueJournal(dialogueJournalPath(runDir, nodeId, attempt));
    return cursor === undefined ? messages : messages.slice(0, cursor);
  }

  async loadEvents(runId: string): Promise<StoredEvent[]> {
    const runDir = await this.resolveRunDir(runId);
    const text = await readFile(join(runDir, "events.ndjson"), "utf8");
    if (!text.trim()) return [];
    const lines = text.split("\n");
    const events: StoredEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch (error) {
        const isTrailingPartial = index === lines.length - 1 && !text.endsWith("\n");
        if (isTrailingPartial) break;
        throw error;
      }
    }
    return events;
  }

  async latestNodeContext(runId: string, nodeId: string, attempt: number): Promise<Extract<StoredEvent, { type: "node_context_updated" }> | undefined> {
    const events = await this.loadEvents(runId).catch(() => [] as StoredEvent[]);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "node_context_updated" && event.node_id === nodeId && event.attempt === attempt) return event;
    }
    return undefined;
  }

  async saveState(runId: string, state: WorkflowState): Promise<void> {
    await this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const metadata = await this.metadata(runId);
      await updateJsonAtomic<WorkflowState>(join(runDir, "state.json"), (current) => {
        const now = new Date().toISOString();
        return persistedWorkflowState({
          ...state,
          version: 4,
          session_id: metadata.sessionId,
          run_id: runId,
          created_at: current?.created_at ?? metadata.createdAt,
          updated_at: now,
          revision: (current?.revision ?? 0) + 1
        });
      });
    });
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
    let state = await readJsonWithBackup<WorkflowState>(join(runDir, "state.json"));
    if (!state) throw new Error(`Run ${runId} has no workflow state`);
    if (state.version === 3) {
      const lease = await this.acquireRunLease(runId);
      try {
        const migrateCheckpoint = async (checkpoint: WorkflowState["resume_checkpoint"]) => {
          if (!checkpoint) return checkpoint;
          const messages = checkpoint.dialogue_messages ?? [];
          const cursor = checkpoint.attempt === undefined ? 0 : await this.syncWorkflowDialogue(runId, checkpoint.node_id, checkpoint.attempt, messages);
          return { ...checkpoint, dialogue_cursor: cursor, dialogue_messages: undefined };
        };
        const nodeCheckpoints: NonNullable<WorkflowState["node_checkpoints"]> = {};
        for (const [nodeId, checkpoint] of Object.entries(state.node_checkpoints ?? {})) {
          nodeCheckpoints[nodeId] = (await migrateCheckpoint(checkpoint))!;
        }
        state = {
          ...state,
          version: 4,
          resume_checkpoint: await migrateCheckpoint(state.resume_checkpoint),
          node_checkpoints: nodeCheckpoints
        };
        await this.saveState(runId, state);
      } finally {
        await lease.release();
      }
    }
    if (state.version !== 4) {
      throw new Error(`Unsupported workflow state version ${String((state as { version?: unknown }).version ?? "legacy")}; start a new run`);
    }
    const hydrateCheckpoint = async (checkpoint: WorkflowState["resume_checkpoint"]) => {
      if (!checkpoint || checkpoint.attempt === undefined) return checkpoint;
      return {
        ...checkpoint,
        dialogue_messages: await this.loadWorkflowDialogue(runId, checkpoint.node_id, checkpoint.attempt, checkpoint.dialogue_cursor)
      };
    };
    const nodeCheckpoints: NonNullable<WorkflowState["node_checkpoints"]> = {};
    for (const [nodeId, checkpoint] of Object.entries(state.node_checkpoints ?? {})) {
      nodeCheckpoints[nodeId] = (await hydrateCheckpoint(checkpoint))!;
    }
    return {
      ...state,
      resume_checkpoint: await hydrateCheckpoint(state.resume_checkpoint),
      node_checkpoints: nodeCheckpoints
    };
  }

  async listRuns(options: { limit?: number } = {}): Promise<RunSummary[]> {
    const runDirs = await this.scanRunDirs();
    const runs: RunSummary[] = [];
    for (const runDir of runDirs) {
      try {
        const metadata = await readJsonWithBackup<RunMetadata>(join(runDir, "run.json"));
        if (!metadata?.runId || !metadata.sessionId) continue;
        this.rememberRun(metadata.runId, metadata.sessionId, runDir);
        runs.push(await this.buildRunSummary(metadata.runId, metadata));
      } catch {
        // Ignore incomplete run directories; explicit resume still reports the underlying error.
      }
    }
    const limit = options.limit ?? runs.length;
    return runs
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.runId.localeCompare(left.runId))
      .slice(0, limit);
  }

  private async buildRunSummary(runId: string, knownMetadata?: RunMetadata): Promise<RunSummary> {
    const runDir = await this.resolveRunDir(runId);
    const metadata = knownMetadata ?? await this.metadata(runId);
    const state = await this.loadState(runId);
    const events = await this.loadEvents(runId).catch(() => [] as StoredEvent[]);
    const started = events.find((event) => event.type === "run_started");
    const latest = events.at(-1);
    const stateStat = await stat(join(runDir, "state.json"));
    return {
      runId,
      sessionId: metadata.sessionId,
      runDir,
      workflowId: metadata.workflowId,
      status: state.status,
      currentNodeId: state.current_node_id,
      startedAt: started?.ts ?? metadata.createdAt,
      updatedAt: latest?.ts ?? stateStat.mtime.toISOString(),
      inputPreview: metadata.initialInputPreview ?? inputPreview(started && "input" in started ? started.input : undefined)
    };
  }

  private async resolveRunDir(runId: string): Promise<string> {
    const cached = this.runDirs.get(runId);
    if (cached) return cached;
    for (const runDir of await this.scanRunDirs()) {
      if (runDir.endsWith(`\\${runId}`) || runDir.endsWith(`/${runId}`)) {
        const metadata = await readJsonWithBackup<RunMetadata>(join(runDir, "run.json")).catch(() => undefined);
        if (metadata?.runId === runId) {
          this.rememberRun(runId, metadata.sessionId, runDir);
          return runDir;
        }
      }
    }
    throw new Error(`Run ${runId} was not found under ${projectDirectory(this.storage)}`);
  }

  private async scanRunDirs(): Promise<string[]> {
    let sessions;
    try {
      sessions = await readdir(projectDirectory(this.storage), { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const results: string[] = [];
    for (const session of sessions) {
      if (!session.isDirectory() || session.name === ".lease-history") continue;
      const runsDir = join(projectDirectory(this.storage), session.name, "runs");
      const runs = await readdir(runsDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      });
      for (const run of runs) {
        if (run.isDirectory() && run.name !== ".lease-history") results.push(join(runsDir, run.name));
      }
    }
    return results;
  }

  private async recordSessionEvent(runId: string, event: HarnessEvent, stored: StoredEvent): Promise<void> {
    const sessionId = this.runSessions.get(runId) ?? (await this.metadata(runId)).sessionId;
    if (event.type === "model_response_recorded") {
      await this.sessionStore.recordModelResponse(sessionId, event.usage);
      return;
    }
    const message = workflowUserMessage(event);
    if (message) {
      await this.sessionStore.appendWorkflowTranscriptEntries(sessionId, [{
        ts: stored.ts,
        message,
        runId,
        entryId: `workflow:${runId}:event:${stored.seq}:user`
      }]);
      return;
    }
    if (isSessionActivityEvent(event)) await this.sessionStore.touch(sessionId, { force: isTerminalEvent(event) });
  }

  private async appendAuditRecords(runId: string, runDir: string, event: HarnessEvent): Promise<void> {
    const sessionId = this.runSessions.get(runId) ?? (await this.metadata(runId)).sessionId;
    const auditStore = new AuditStore(dirname(dirname(runDir)));
    for (const auditEvent of this.auditEvents(sessionId, runId, event)) {
      await auditStore.append(auditEvent);
    }
  }

  private auditEvents(sessionId: string, runId: string, event: HarnessEvent): AuditEvent[] {
    const identity = { session_id: sessionId, run_id: runId };
    if (event.type === "tool_invoked") {
      const records: AuditEvent[] = [{ ...identity, type: "tool_invocation", node_id: event.node_id, attempt: event.attempt, tool: event.tool, input: event.input }];
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      if (event.tool === "Write" || event.tool === "Edit" || event.tool === "MultiEdit") {
        const path = String(input.file_path ?? input.path ?? "");
        records.push({ ...identity, type: "file_write", node_id: event.node_id, attempt: event.attempt, tool: event.tool, path });
      }
      if (event.tool === "Bash" || event.tool === "PowerShell") {
        const command = String(input.command ?? "");
        records.push({ ...identity, type: "shell_command", node_id: event.node_id, attempt: event.attempt, tool: event.tool, command, destructive: isDestructiveShellCommand(input) });
      }
      return records;
    }
    if (event.type === "tool_completed") {
      return [{ ...identity, type: "tool_result", node_id: event.node_id, attempt: event.attempt, tool: event.tool, status: "completed", result: event.result }];
    }
    if (event.type === "tool_failed") {
      return [{ ...identity, type: "tool_result", node_id: event.node_id, attempt: event.attempt, tool: event.tool, status: "failed", error: event.error }];
    }
    if (event.type === "artifact_read") {
      return [{ ...identity, type: "artifact_read", node_id: event.node_id, attempt: event.attempt, artifact_id: event.artifact_id, offset: event.offset, bytes_read: event.bytes_read, total_bytes: event.total_bytes, truncated: event.truncated, source: event.source }];
    }
    if (event.type === "skill_activated") {
      return [{ ...identity, type: "skill_activated", node_id: event.node_id, attempt: event.attempt, name: event.name, mode: event.mode, source: event.source, version: event.version, allowed_tools: event.allowed_tools }];
    }
    if (event.type === "permission_requested") {
      this.pendingPermissions.set(event.request_id, { tool: event.tool, nodeId: event.node_id, attempt: event.attempt, rule: event.rule });
      return [{ ...identity, type: "permission_decision", node_id: event.node_id, attempt: event.attempt, tool: event.tool, decision: "ask", rule: event.rule, input: event.input }];
    }
    if (event.type === "permission_resolved") {
      const pending = this.pendingPermissions.get(event.request_id);
      this.pendingPermissions.delete(event.request_id);
      if (!pending) return [];
      return [{ ...identity, type: "permission_decision", node_id: pending.nodeId, attempt: pending.attempt, tool: pending.tool, decision: event.decision === "allow_once" ? "allow" : "deny", rule: pending.rule }];
    }
    return [];
  }

  private async resolveNextSeq(runId: string, eventsPath: string): Promise<number> {
    const cached = this.nextSeq.get(runId);
    if (cached !== undefined) return cached;
    try {
      const events = await this.loadEvents(runId);
      const next = (events.at(-1)?.seq ?? 0) + 1;
      this.nextSeq.set(runId, next);
      return next;
    } catch {
      const text = await readFile(eventsPath, "utf8").catch(() => "");
      const next = text.trim() ? text.trim().split("\n").length + 1 : 1;
      this.nextSeq.set(runId, next);
      return next;
    }
  }

  private rememberRun(runId: string, sessionId: string, runDir: string): void {
    this.runDirs.set(runId, runDir);
    this.runSessions.set(runId, sessionId);
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

function dialogueJournalPath(runDir: string, nodeId: string, attempt: number): string {
  return join(runDir, "dialogue", `${encodeURIComponent(nodeId)}-attempt-${attempt}.ndjson`);
}

async function readDialogueJournal(path: string): Promise<ModelMessage[]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return "";
    throw error;
  });
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const messages: ModelMessage[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      messages.push(JSON.parse(line) as ModelMessage);
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      throw error;
    }
  }
  return messages;
}

function persistedWorkflowState(state: WorkflowState): WorkflowState {
  const checkpoint = (value: WorkflowState["resume_checkpoint"]) => value ? { ...value, dialogue_messages: undefined } : value;
  return {
    ...state,
    version: 4,
    resume_checkpoint: checkpoint(state.resume_checkpoint),
    node_checkpoints: Object.fromEntries(Object.entries(state.node_checkpoints ?? {}).map(([nodeId, value]) => [nodeId, checkpoint(value)!]))
  };
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

function workflowUserMessage(event: HarnessEvent): ModelMessage | undefined {
  if (event.type === "user_message") return { role: "user", content: event.text };
  if (event.type !== "run_started" && event.type !== "run_continued") return undefined;
  return { role: "user", content: workflowInputText(event.input) };
}

function workflowInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    if (typeof value.request === "string") return value.request;
    if (typeof value.answer === "string") return value.answer;
    return JSON.stringify(value);
  }
  return input === undefined ? "" : String(input);
}

function isSessionActivityEvent(event: HarnessEvent): boolean {
  return event.type !== "model_thinking_delta"
    && event.type !== "model_stream_delta"
    && event.type !== "model_usage_recorded";
}

function isTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed";
}

function isAuditableEvent(event: HarnessEvent): boolean {
  return event.type === "tool_invoked"
    || event.type === "tool_completed"
    || event.type === "tool_failed"
    || event.type === "artifact_read"
    || event.type === "skill_activated"
    || event.type === "permission_requested"
    || event.type === "permission_resolved";
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

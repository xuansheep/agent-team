import { appendFile, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
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
import type { ExecutionKind } from "../config/schema.js";

export type RunMetadata = {
  version: 1;
  runId: string;
  sessionId: string;
  workflowId: string;
  executionKind?: ExecutionKind;
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
  executionKind: ExecutionKind;
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
  executionKind?: ExecutionKind;
  permissionMode?: string;
};

export type WorkflowDialogueWindow = {
  windowNumber: number;
  firstWindowId: string;
  previousWindowId?: string;
  currentWindowId: string;
  model?: string;
  compactionHash?: string;
  contextWindow?: number;
  prefixInputTokens?: number;
};

export type WorkflowDialogueCompaction = {
  replacementHistory: ModelMessage[];
  phase: "pre_turn" | "mid_turn";
  reason: "threshold" | "model_change" | "smaller_context";
  model: string;
  compactionHash?: string;
  contextWindow: number;
  prefixInputTokens?: number;
};

export type ProviderContinuationCheckpoint = {
  version: 2;
  nodeId: string;
  attempt: number;
  activation: number;
  providerId: string;
  model: string;
  systemHash: string;
  toolsHash: string;
  responseSchemaHash: string;
  requestPropertiesHash: string;
  windowId: string;
  historyPrefixHash: string;
  messageCount: number;
  previousResponseId: string;
  updatedAt: string;
};

export type WorkflowDialogueState = {
  cursor: number;
  messages: ModelMessage[];
  window: WorkflowDialogueWindow;
};

type DialogueJournalRecord =
  | ModelMessage
  | {
      journal_type: "compacted";
      replacement_history: ModelMessage[];
      phase: WorkflowDialogueCompaction["phase"];
      reason: WorkflowDialogueCompaction["reason"];
      model: string;
      compaction_hash?: string;
      context_window: number;
      prefix_input_tokens?: number;
      window_number: number;
      first_window_id: string;
      previous_window_id: string;
      current_window_id: string;
    }
  | { journal_type: "reconcile"; messages: ModelMessage[] };

export class RunStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly leaseQueues = new Map<string, Promise<unknown>>();
  private readonly heldRunLeases = new Map<string, { lease: FileLease; references: number }>();
  private readonly runDirs = new Map<string, string>();
  private readonly runSessions = new Map<string, string>();
  private readonly nextSeq = new Map<string, number>();
  private readonly dialogueStates = new Map<string, WorkflowDialogueState>();
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
    await this.sessionStore.assertRunAttachable(sessionId, runId);
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
      ...(options.executionKind ? { executionKind: options.executionKind } : {}),
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
      if (
        event.type === "tool_invoked"
        || event.type === "tool_completed"
        || event.type === "tool_failed"
        || event.type === "managed_process_started"
        || event.type === "managed_process_stopped"
        || event.type === "managed_process_cleanup_failed"
      ) {
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

  async syncWorkflowDialogue(runId: string, nodeId: string, attempt: number, messages: ModelMessage[], activation = 1): Promise<number> {
    return this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const path = dialogueJournalPath(runDir, nodeId, attempt, activation);
      const state = await this.ensureWorkflowDialogueState(runId, nodeId, attempt, activation, path);
      if (messages.length < state.messages.length) {
        throw new Error(`Dialogue for ${nodeId} attempt ${attempt} moved backward from ${state.messages.length} to ${messages.length} active messages`);
      }
      for (let index = 0; index < state.messages.length; index += 1) {
        if (JSON.stringify(messages[index]) !== JSON.stringify(state.messages[index])) {
          throw new Error(`Dialogue for ${nodeId} attempt ${attempt} diverged at active message ${index}`);
        }
      }

      const pending = messages.slice(state.messages.length);
      if (!pending.length) return state.cursor;
      await appendDialogueJournalRecords(path, pending);
      const previousCursor = state.cursor;
      state.messages = [...state.messages, ...pending];
      state.cursor += pending.length;
      const sessionId = this.runSessions.get(runId) ?? (await this.metadata(runId)).sessionId;
      const entries = pending.flatMap((message, index) =>
        message.role === "assistant" || message.role === "tool"
          ? [{ message, runId, entryId: `workflow:${runId}:node:${nodeId}:attempt:${attempt}:message:${previousCursor + index}` }]
          : []
      );
      await this.sessionStore.appendWorkflowTranscriptEntries(sessionId, entries);
      return state.cursor;
    });
  }

  async reconcileWorkflowDialogue(
    runId: string,
    nodeId: string,
    attempt: number,
    messages: ModelMessage[],
    recoveredMessages: ModelMessage[],
    activation = 1
  ): Promise<WorkflowDialogueState> {
    return this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const path = dialogueJournalPath(runDir, nodeId, attempt, activation);
      const state = await this.ensureWorkflowDialogueState(runId, nodeId, attempt, activation, path);
      await writeJsonAtomic(providerContinuationCheckpointPath(runDir, nodeId, attempt, activation), null, { backupPath: false });
      const record: DialogueJournalRecord = {
        journal_type: "reconcile",
        messages: [...messages]
      };
      await appendDialogueJournalRecords(path, [record]);
      const previousCursor = state.cursor;
      state.messages = [...messages];
      state.cursor += 1;
      const sessionId = this.runSessions.get(runId) ?? (await this.metadata(runId)).sessionId;
      const entries = recoveredMessages.flatMap((message, index) =>
        message.role === "assistant" || message.role === "tool"
          ? [{ message, runId, entryId: `workflow:${runId}:node:${nodeId}:attempt:${attempt}:reconcile:${previousCursor}:${index}` }]
          : []
      );
      await this.sessionStore.appendWorkflowTranscriptEntries(sessionId, entries);
      return { cursor: state.cursor, messages: [...state.messages], window: { ...state.window } };
    });
  }

  async compactWorkflowDialogue(
    runId: string,
    nodeId: string,
    attempt: number,
    compaction: WorkflowDialogueCompaction,
    activation = 1
  ): Promise<WorkflowDialogueState> {
    return this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      const path = dialogueJournalPath(runDir, nodeId, attempt, activation);
      const state = await this.ensureWorkflowDialogueState(runId, nodeId, attempt, activation, path);
      await writeJsonAtomic(providerContinuationCheckpointPath(runDir, nodeId, attempt, activation), null, { backupPath: false });
      const currentWindow = state.window;
      const nextWindow: WorkflowDialogueWindow = {
        windowNumber: currentWindow.windowNumber + 1,
        firstWindowId: currentWindow.firstWindowId,
        previousWindowId: currentWindow.currentWindowId,
        currentWindowId: uuidV7(),
        model: compaction.model,
        compactionHash: compaction.compactionHash,
        contextWindow: compaction.contextWindow,
        prefixInputTokens: compaction.prefixInputTokens
      };
      const record: DialogueJournalRecord = {
        journal_type: "compacted",
        replacement_history: [...compaction.replacementHistory],
        phase: compaction.phase,
        reason: compaction.reason,
        model: compaction.model,
        compaction_hash: compaction.compactionHash,
        context_window: compaction.contextWindow,
        prefix_input_tokens: compaction.prefixInputTokens,
        window_number: nextWindow.windowNumber,
        first_window_id: nextWindow.firstWindowId,
        previous_window_id: nextWindow.previousWindowId!,
        current_window_id: nextWindow.currentWindowId
      };
      await appendDialogueJournalRecords(path, [record]);
      state.messages = applyDialogueJournalRecord(state.messages, record);
      state.window = nextWindow;
      state.cursor += 1;
      return { cursor: state.cursor, messages: [...state.messages], window: { ...state.window } };
    });
  }

  async loadWorkflowDialogueState(runId: string, nodeId: string, attempt: number, cursor?: number, activation = 1): Promise<WorkflowDialogueState> {
    const runDir = await this.resolveRunDir(runId);
    const state = await readDialogueJournalState(dialogueJournalPath(runDir, nodeId, attempt, activation), cursor);
    if (cursor === undefined) this.dialogueStates.set(dialogueStateKey(runId, nodeId, attempt, activation), state);
    return { cursor: state.cursor, messages: [...state.messages], window: { ...state.window } };
  }

  async loadWorkflowDialogue(runId: string, nodeId: string, attempt: number, cursor?: number, activation = 1): Promise<ModelMessage[]> {
    return (await this.loadWorkflowDialogueState(runId, nodeId, attempt, cursor, activation)).messages;
  }

  async loadProviderContinuationCheckpoint(
    runId: string,
    nodeId: string,
    attempt: number,
    activation = 1
  ): Promise<ProviderContinuationCheckpoint | undefined> {
    const runDir = await this.resolveRunDir(runId);
    const checkpoint = await readJsonWithBackup<ProviderContinuationCheckpoint | null>(
      providerContinuationCheckpointPath(runDir, nodeId, attempt, activation),
      { backupPath: false }
    );
    if (
      !checkpoint
      || checkpoint.version !== 2
      || checkpoint.nodeId !== nodeId
      || checkpoint.attempt !== attempt
      || checkpoint.activation !== activation
    ) return undefined;
    return checkpoint;
  }

  async saveProviderContinuationCheckpoint(runId: string, checkpoint: ProviderContinuationCheckpoint): Promise<void> {
    await this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      await writeJsonAtomic(
        providerContinuationCheckpointPath(runDir, checkpoint.nodeId, checkpoint.attempt, checkpoint.activation),
        checkpoint,
        { backupPath: false }
      );
    });
  }

  async clearProviderContinuationCheckpoint(runId: string, nodeId: string, attempt: number, activation = 1): Promise<void> {
    await this.enqueueRunWrite(runId, async () => {
      const runDir = await this.resolveRunDir(runId);
      await writeJsonAtomic(providerContinuationCheckpointPath(runDir, nodeId, attempt, activation), null, { backupPath: false });
    });
  }

  private async ensureWorkflowDialogueState(
    runId: string,
    nodeId: string,
    attempt: number,
    activation: number,
    path: string
  ): Promise<WorkflowDialogueState> {
    const key = dialogueStateKey(runId, nodeId, attempt, activation);
    let state = this.dialogueStates.get(key);
    if (!state) {
      state = await readDialogueJournalState(path);
      this.dialogueStates.set(key, state);
    }
    return state;
  }

  async loadEvents(runId: string): Promise<StoredEvent[]> {
    const runDir = await this.resolveRunDir(runId);
    const text = await readFile(join(runDir, "events.ndjson"), "utf8");
    if (!text.trim()) return [];
    const lines = text.split("\n");
    const events: StoredEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      // A crash mid-append leaves a torn line. Losing that one event is recoverable; refusing to
      // read the file at all would make the whole run permanently unresumable.
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        continue;
      }
    }
    return events;
  }

  async latestNodeContext(runId: string, nodeId: string, attempt: number, activation = 1): Promise<Extract<StoredEvent, { type: "node_context_updated" }> | undefined> {
    const events = await this.loadEvents(runId).catch(() => [] as StoredEvent[]);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "node_context_updated" && event.node_id === nodeId && event.attempt === attempt && (event.activation ?? 1) === activation) return event;
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
          version: 5,
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
    const version = state.version;
    if (version !== 2 && version !== 3 && version !== 4 && version !== 5) {
      throw new Error(`Unsupported workflow state version ${String((state as { version?: unknown }).version ?? "legacy")}; start a new run`);
    }
    const legacy = version !== 5;
    const hydrateCheckpoint = async (checkpoint: WorkflowState["resume_checkpoint"]) => {
      if (!checkpoint || checkpoint.attempt === undefined) return checkpoint;
      if (legacy) {
        const messages = [...checkpoint.dialogue_messages ?? []];
        return { ...checkpoint, dialogue_cursor: checkpoint.dialogue_cursor ?? messages.length, dialogue_messages: messages };
      }
      const dialogue = await this.loadWorkflowDialogueState(runId, checkpoint.node_id, checkpoint.attempt, undefined, checkpoint.activation ?? 1);
      return {
        ...checkpoint,
        dialogue_cursor: dialogue.cursor,
        dialogue_messages: dialogue.messages
      };
    };
    const nodeCheckpoints: NonNullable<WorkflowState["node_checkpoints"]> = {};
    for (const [nodeId, checkpoint] of Object.entries(state.node_checkpoints ?? {})) {
      nodeCheckpoints[nodeId] = (await hydrateCheckpoint(checkpoint))!;
    }
    return {
      ...state,
      version: 5,
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
      executionKind: state.execution_kind ?? metadata.executionKind ?? "workflow",
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
    if (event.type === "run_completed") {
      await this.sessionStore.syncWorkflowRunStatus(sessionId, runId, "completed");
      return;
    }
    if (event.type === "run_continued" || event.type === "user_message") {
      await this.sessionStore.syncWorkflowRunStatus(sessionId, runId, "running");
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
    if (event.type === "mcp_catalog_published") {
      return [{ ...identity, type: "mcp_catalog_published", node_id: event.node_id, attempt: event.attempt, revision: event.revision, protocol: event.protocol, deferred_tools: event.deferred_tools, discovered_tools: event.discovered_tools, pending_servers: event.pending_servers, failed_servers: event.failed_servers }];
    }
    if (event.type === "mcp_tools_discovered") {
      return [{ ...identity, type: "mcp_tools_discovered", node_id: event.node_id, attempt: event.attempt, query: event.query, tools: event.tools }];
    }
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
    if (event.type === "managed_process_started") {
      return [{
        ...identity,
        type: "managed_process",
        action: "started",
        node_id: event.node_id,
        attempt: event.attempt,
        process_id: event.process_id,
        pid: event.pid,
        executable: event.executable,
        output_path: event.output_path
      }];
    }
    if (event.type === "managed_process_stopped") {
      return [{
        ...identity,
        type: "managed_process",
        action: "stopped",
        node_id: event.node_id,
        attempt: event.attempt,
        process_id: event.process_id,
        pid: event.pid,
        reason: event.reason,
        exit_code: event.exit_code
      }];
    }
    if (event.type === "managed_process_cleanup_failed") {
      return [{
        ...identity,
        type: "managed_process",
        action: "cleanup_failed",
        node_id: event.node_id,
        attempt: event.attempt,
        process_id: event.process_id,
        pid: event.pid,
        reason: event.reason,
        error: event.error
      }];
    }
    if (event.type === "artifact_read") {
      return [{ ...identity, type: "artifact_read", node_id: event.node_id, attempt: event.attempt, artifact_id: event.artifact_id, offset: event.offset, bytes_read: event.bytes_read, total_bytes: event.total_bytes, truncated: event.truncated, source: event.source }];
    }
    if (event.type === "skill_activated") {
      return [{ ...identity, type: "skill_activated", node_id: event.node_id, attempt: event.attempt, name: event.name, mode: event.mode, source: event.source, version: event.version, allowed_tools: event.allowed_tools }];
    }
    if (event.type === "model_retry_scheduled") {
      return [{
        ...identity,
        type: "model_retry",
        node_id: event.node_id,
        attempt: event.attempt,
        operation: event.operation,
        phase: event.phase,
        retry_attempt: event.retry_attempt,
        max_retries: event.max_retries,
        retry_in_ms: event.retry_in_ms,
        retry_at: event.retry_at,
        error_kind: event.error_kind,
        status: event.status,
        error: event.error,
        discarded_content_chars: event.discarded_content_chars,
        discarded_thinking_chars: event.discarded_thinking_chars
      }];
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
      // Use the maximum rather than the last entry: a torn line skipped by loadEvents would
      // otherwise hand out a seq that is already in use.
      const next = events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
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

function providerContinuationCheckpointPath(runDir: string, nodeId: string, attempt: number, activation: number): string {
  return join(runDir, "provider-continuation-" + encodeURIComponent(nodeId) + "-attempt-" + attempt + "-activation-" + activation + ".json");
}

function dialogueJournalPath(runDir: string, nodeId: string, attempt: number, activation = 1): string {
  const activationSuffix = activation > 1 ? `-activation-${activation}` : "";
  return join(runDir, "dialogue", `${encodeURIComponent(nodeId)}-attempt-${attempt}${activationSuffix}.ndjson`);
}

function dialogueStateKey(runId: string, nodeId: string, attempt: number, activation: number): string {
  return `${runId}:${nodeId}:${attempt}:${activation}`;
}

async function appendDialogueJournalRecords(path: string, records: readonly DialogueJournalRecord[]): Promise<void> {
  if (!records.length) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readDialogueJournalState(path: string, cursor?: number): Promise<WorkflowDialogueState> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return "";
    throw error;
  });
  let window = initialDialogueWindow();
  if (!text.trim()) return { cursor: 0, messages: [], window };

  const lines = text.split("\n");
  let messages: ModelMessage[] = [];
  let recordCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (cursor !== undefined && recordCount >= cursor) break;
    const line = lines[index];
    if (!line) continue;
    try {
      const record = JSON.parse(line) as DialogueJournalRecord;
      messages = applyDialogueJournalRecord(messages, record);
      if ("journal_type" in record && record.journal_type === "compacted") {
        window = {
          windowNumber: record.window_number,
          firstWindowId: record.first_window_id,
          previousWindowId: record.previous_window_id,
          currentWindowId: record.current_window_id,
          model: record.model,
          compactionHash: record.compaction_hash,
          contextWindow: record.context_window,
          prefixInputTokens: record.prefix_input_tokens
        };
      }
      recordCount += 1;
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      throw error;
    }
  }
  return { cursor: recordCount, messages, window };
}

function applyDialogueJournalRecord(messages: readonly ModelMessage[], record: DialogueJournalRecord): ModelMessage[] {
  if (!("journal_type" in record)) return [...messages, record];
  if (record.journal_type === "compacted") return [...record.replacement_history];
  if (record.journal_type === "reconcile") return [...record.messages];
  throw new Error(`Unsupported legacy dialogue journal record ${String((record as { journal_type?: unknown }).journal_type)}; start a new run`);
}

function persistedWorkflowState(state: WorkflowState): WorkflowState {
  const checkpoint = (value: WorkflowState["resume_checkpoint"]) => value ? { ...value, dialogue_messages: undefined } : value;
  return {
    ...state,
    version: 5,
    resume_checkpoint: checkpoint(state.resume_checkpoint),
    node_checkpoints: Object.fromEntries(Object.entries(state.node_checkpoints ?? {}).map(([nodeId, value]) => [nodeId, checkpoint(value)!]))
  };
}

function initialDialogueWindow(): WorkflowDialogueWindow {
  const id = uuidV7();
  return { windowNumber: 0, firstWindowId: id, currentWindowId: id };
}

function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  if (event.type === "user_message") return { role: "user", content: event.text, metadata: { userMessageKind: "human" } };
  if (event.type !== "run_started" && event.type !== "run_continued") return undefined;
  return { role: "user", content: workflowInputText(event.input), metadata: { userMessageKind: "human" } };
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
    && event.type !== "model_usage_recorded"
    && event.type !== "provider_continuation_fallback";
}

function isTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed";
}

function isAuditableEvent(event: HarnessEvent): boolean {
  return event.type === "model_retry_scheduled"
    || event.type === "tool_invoked"
    || event.type === "tool_completed"
    || event.type === "tool_failed"
    || event.type === "managed_process_started"
    || event.type === "managed_process_stopped"
    || event.type === "managed_process_cleanup_failed"
    || event.type === "artifact_read"
    || event.type === "skill_activated"
    || event.type === "permission_requested"
    || event.type === "permission_resolved";
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

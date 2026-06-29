import { EventStream } from "../harness/eventStream.js";
import { PermissionController } from "../harness/permissionController.js";
import { StoredEvent, HarnessEvent } from "../harness/events.js";
import { RunStore } from "../storage/runStore.js";
import { WorkflowState } from "./state.js";
import { WorkflowSession } from "./session.js";
import { WorkflowConfig } from "../config/schema.js";
import { RuntimeInteraction } from "../harness/runtime.js";

/**
 * Segment of work within an interactive session.
 */
export type InteractiveSegment = {
  startNodeId: string;
  initialHandoff: unknown;
  attempts: WorkflowState["attempts"];
};

/**
 * Callback supplied by the engine to execute a segment.
 */
export type RunSegmentCallback = (
  segment: InteractiveSegment,
  interaction?: RuntimeInteraction,
  onState?: (state: WorkflowState) => void
) => Promise<WorkflowState>;

/**
 * Encapsulates the reusable interactive session lifecycle.
 *
 * Both startInteractive and resumeInteractive in WorkflowEngine share
 * identical patterns for:
 *  - EventStream creation and replay
 *  - PermissionController management
 *  - Interruption state
 *  - Result promise lifecycle
 *  - Session method construction
 */
export class InteractiveSessionRunner {
  readonly runId: string;
  readonly events: EventStream<StoredEvent>;
  readonly permissions: PermissionController;
  readonly result: Promise<WorkflowState>;

  private _state: WorkflowState;
  private _interrupted = false;
  private _resultSettled = false;
  private _activeRun: Promise<WorkflowState> | undefined;
  private _resolveResult!: (state: WorkflowState) => void;
  private _rejectResult!: (error: unknown) => void;
  private _runSegment: RunSegmentCallback;
  private _store: RunStore;

  constructor(
    runSegment: RunSegmentCallback,
    runId: string,
    store: RunStore,
    initialState: WorkflowState
  ) {
    this._runSegment = runSegment;
    this.runId = runId;
    this._store = store;
    this._state = initialState;

    this.events = new EventStream<StoredEvent>();
    this.permissions = new PermissionController();
    this.result = new Promise<WorkflowState>((resolve, reject) => {
      this._resolveResult = resolve;
      this._rejectResult = reject;
    });
  }

  get state(): WorkflowState {
    return this._state;
  }

  /** Replay historical events into the stream. */
  replayEvents(events: StoredEvent[]): void {
    for (const event of events) {
      this.events.push(event);
    }
  }

  /** Mark the workflow as finished. */
  finish(state: WorkflowState): void {
    this._state = state;
    if (!this._resultSettled) {
      this._resultSettled = true;
      this._resolveResult(state);
    }
    this.events.end();
  }

  /** Fail the workflow. */
  async fail(error: unknown): Promise<void> {
    const formatted = this._formatError(error);
    const failedState: WorkflowState = { ...this._state, status: "pending" };
    this._state = failedState;
    await this._store.saveState(this.runId, failedState);
    const event = await this._store.appendEvent(this.runId, {
      type: "run_failed",
      error: formatted.message,
      ...(formatted.detail ? { detail: formatted.detail } : {})
    });
    this.events.push(event);
    if (!this._resultSettled) {
      this._resultSettled = true;
      this._rejectResult(error);
    }
    this.events.end();
  }

  /** Finish only when terminal (completed). */
  finishWhenTerminal(state: WorkflowState): void {
    this._state = state;
    if (state.status === "completed") this.finish(state);
  }

  /** Run a segment, guarding against concurrency. */
  async runSegment(
    segment: InteractiveSegment,
    interaction?: RuntimeInteraction,
    onState?: (state: WorkflowState) => void
  ): Promise<WorkflowState> {
    if (this._activeRun) throw new Error(`Run ${this.runId} is already active`);
    this._activeRun = this._runSegment(segment, interaction, onState);
    try {
      const state = await this._activeRun;
      this.finishWhenTerminal(state);
      return state;
    } finally {
      this._activeRun = undefined;
    }
  }

  /** Interrupt the current run. */
  async interrupt(): Promise<void> {
    if ((this._resultSettled && !this._activeRun) || this._interrupted) return;
    this._interrupted = true;
    this.permissions.resolveAll("deny_once");
  }

  get isInterrupted(): boolean {
    return this._interrupted;
  }

  get isResultSettled(): boolean {
    return this._resultSettled;
  }

  get activeRun(): Promise<WorkflowState> | undefined {
    return this._activeRun;
  }

  resetInterrupted(): void {
    this._interrupted = false;
  }

  /** Create the interaction handler for permission requests. */
  createInteraction(): RuntimeInteraction {
    return {
      requestPermission: (request) => this.permissions.request(request)
    };
  }

  /** Push an event into the stream and the store. */
  async pushEvent(event: HarnessEvent): Promise<StoredEvent> {
    const stored = await this._store.appendEvent(this.runId, event);
    this.events.push(stored);
    return stored;
  }

  /** Reload stored events and push them into the stream. */
  async reloadEvents(): Promise<void> {
    for (const event of await this._store.loadEvents(this.runId)) {
      this.events.push(event);
    }
  }

  /** Save state. */
  async saveState(state: WorkflowState): Promise<void> {
    await this._store.saveState(this.runId, state);
  }

  private _formatError(error: unknown): { message: string; detail?: string } {
    const message = error instanceof Error ? error.message : String(error);
    const detail = this._explicitDetail(error);
    return detail ? { message, detail } : { message };
  }

  private _explicitDetail(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const detail = (error as { detail?: unknown }).detail;
    return typeof detail === "string" && detail.trim() ? detail : undefined;
  }
}

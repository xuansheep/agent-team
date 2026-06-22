import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessEvent, StoredEvent } from "../harness/events.js";
import { WorkflowState } from "../workflow/state.js";

export class RunStore {
  constructor(private readonly rootDir = ".runs") {}

  async createRun(workflowId: string, input: unknown): Promise<{ runId: string; runDir: string }> {
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const runDir = this.runDir(runId);
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "events.ndjson"), "", "utf8");
    await this.appendEvent(runId, { type: "run_started", workflow_id: workflowId, input });
    return { runId, runDir };
  }

  runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  async appendEvent(runId: string, event: HarnessEvent): Promise<StoredEvent> {
    const runDir = this.runDir(runId);
    const eventsPath = join(runDir, "events.ndjson");
    const existing = await readFile(eventsPath, "utf8").catch(() => "");
    const seq = existing.trim() ? existing.trim().split("\n").length + 1 : 1;
    const stored: StoredEvent = { ...event, ts: new Date().toISOString(), seq };
    await writeFile(eventsPath, `${existing}${JSON.stringify(stored)}\n`, "utf8");
    return stored;
  }

  async loadEvents(runId: string): Promise<StoredEvent[]> {
    const text = await readFile(join(this.runDir(runId), "events.ndjson"), "utf8");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as StoredEvent) : [];
  }

  async saveState(runId: string, state: WorkflowState): Promise<void> {
    await writeFile(join(this.runDir(runId), "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async loadState(runId: string): Promise<WorkflowState> {
    return JSON.parse(await readFile(join(this.runDir(runId), "state.json"), "utf8")) as WorkflowState;
  }
}

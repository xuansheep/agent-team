import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

import { join } from "node:path";

import { randomUUID } from "node:crypto";

import { HarnessEvent, StoredEvent } from "../harness/events.js";

import { WorkflowState } from "../workflow/state.js";



export type RunSummary = {

  runId: string;

  workflowId: string;

  status: WorkflowState["status"];

  currentNodeId?: string;

  startedAt?: string;

  updatedAt: string;

  inputPreview: string;

};



export class RunStore {

  constructor(private readonly rootDir = ".session") {}



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



  async markInterrupted(runId: string, state: WorkflowState): Promise<void> {

    await this.appendEvent(runId, { type: "run_interrupted", reason: "user" });

    await this.saveState(runId, state);

  }



  async loadState(runId: string): Promise<WorkflowState> {
    const statePath = join(this.runDir(runId), "state.json");
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return JSON.parse(await readFile(statePath, "utf8")) as WorkflowState;
      } catch (error) {
        lastError = error;
        if (!(error instanceof SyntaxError) || attempt === 4) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError;
  }

  async listRuns(options: { limit?: number } = {}): Promise<RunSummary[]> {

    let entries;

    try {

      entries = await readdir(this.rootDir, { withFileTypes: true });

    } catch (error) {

      if (isErrno(error, "ENOENT")) return [];

      throw error;

    }



    const runs: RunSummary[] = [];

    for (const entry of entries) {

      if (!entry.isDirectory()) continue;

      const runId = entry.name;

      try {

        const state = await this.loadState(runId);

        const events = await this.loadEvents(runId).catch(() => [] as StoredEvent[]);

        const started = events.find((event) => event.type === "run_started");

        const latest = events.at(-1);

        const stateStat = await stat(join(this.runDir(runId), "state.json"));

        runs.push({

          runId,

          workflowId: state.workflow_id,

          status: state.status,

          currentNodeId: state.current_node_id,

          startedAt: started?.ts,

          updatedAt: latest?.ts ?? stateStat.mtime.toISOString(),

          inputPreview: inputPreview(started && "input" in started ? started.input : undefined)

        });

      } catch {

        // Ignore partially-written or manually-corrupted run directories.

      }

    }



    const limit = options.limit ?? runs.length;

    return runs

      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.runId.localeCompare(a.runId))

      .slice(0, limit);

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


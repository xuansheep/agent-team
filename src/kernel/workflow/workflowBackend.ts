import type { ApprovedPlanHandoff } from "../plan/planModeController.js";

export type WorkflowBackendRun = {
  runId: string;
  status: "pending" | "running" | "waiting" | "completed";
};

export type WorkflowBackendOptions = {
  startWorkflow: (handoff: unknown) => Promise<WorkflowBackendRun>;
};

export class WorkflowBackend {
  private readonly runs = new Map<string, WorkflowBackendRun>();

  constructor(private readonly options: WorkflowBackendOptions) {}

  async startOrResume(handoff: ApprovedPlanHandoff): Promise<WorkflowBackendRun> {
    const key = `${handoff.sessionId}:${handoff.approvalId}:${handoff.planHash}`;
    const existing = this.runs.get(key);
    if (existing) return existing;

    const run = await this.options.startWorkflow(handoff.legacyHandoff);
    this.runs.set(key, run);
    return run;
  }
}

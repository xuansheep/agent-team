import { randomUUID } from "node:crypto";
import { TaskEvent, TaskHandler, TaskRecord, TaskRunContext, TaskRunResult, TaskStartInput } from "./types.js";

export class TaskRegistry {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly completions = new Map<string, Promise<TaskRecord>>();

  register(kind: string, handler: TaskHandler): void {
    if (this.handlers.has(kind)) throw new Error(`Duplicate task kind ${kind}`);
    this.handlers.set(kind, handler);
  }

  startTask(input: TaskStartInput, context: TaskRunContext): TaskRecord {
    assertNoPlanModeTaskExecution(input.input, context);
    const handler = this.handlers.get(input.kind);
    if (!handler) throw new Error(`Unknown task kind ${input.kind}`);

    const now = timestamp();
    const task: TaskRecord = {
      id: randomUUID(),
      kind: input.kind,
      name: input.name,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      input: input.input,
      parentSessionId: input.parentSessionId,
      events: []
    };
    this.tasks.set(task.id, task);
    void this.emit(context, { type: "task_created", task_id: task.id, kind: task.kind });

    const completion = this.runTask(task.id, handler, context);
    this.completions.set(task.id, completion);
    return this.clone(task);
  }

  getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    return this.clone(task);
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()].map((task) => this.clone(task));
  }

  async waitForTask(taskId: string): Promise<TaskRecord> {
    const completion = this.completions.get(taskId);
    if (!completion) return this.getTask(taskId);
    return this.clone(await completion);
  }

  private async runTask(taskId: string, handler: TaskHandler, context: TaskRunContext): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    this.updateTask(taskId, { status: "running" });
    await this.emit(context, { type: "task_started", task_id: task.id, kind: task.kind });

    try {
      const result = await handler(this.getTask(taskId), context);
      const updated = this.applyResult(taskId, result);
      if (updated.status === "completed") {
        await this.emit(context, { type: "task_completed", task_id: taskId, result: updated.result });
      } else if (updated.status === "waiting_plan_approval" && updated.planApprovalId) {
        await this.emit(context, { type: "task_waiting_plan_approval", task_id: taskId, plan_approval_id: updated.planApprovalId });
      }
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = this.updateTask(taskId, { status: "failed", error: message });
      await this.emit(context, { type: "task_failed", task_id: taskId, error: message });
      return updated;
    }
  }

  private applyResult(taskId: string, result: TaskRunResult): TaskRecord {
    if (result.status === "failed") {
      return this.updateTask(taskId, { status: "failed", error: result.error, events: result.events });
    }
    if (result.status === "waiting_plan_approval") {
      return this.updateTask(taskId, {
        status: "waiting_plan_approval",
        result: result.result,
        output: result.output,
        sessionId: result.sessionId,
        planApprovalId: result.planApprovalId,
        events: result.events
      });
    }
    return this.updateTask(taskId, {
      status: "completed",
      result: result.result,
      output: result.output,
      sessionId: result.sessionId,
      events: result.events
    });
  }

  private updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const current = this.requireTask(taskId);
    const next: TaskRecord = {
      ...current,
      ...patch,
      events: [...current.events, ...patch.events ?? []],
      updatedAt: timestamp()
    };
    this.tasks.set(taskId, next);
    return this.clone(next);
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    return task;
  }

  private clone(task: TaskRecord): TaskRecord {
    return { ...task, events: task.events.slice() };
  }

  private async emit(context: TaskRunContext, event: TaskEvent): Promise<void> {
    await context.eventSink?.(event);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function assertNoPlanModeTaskExecution(input: unknown, context?: Pick<TaskRunContext, "permissions">): void {
  if (context?.permissions?.mode === "plan" || containsPlanModeRequest(input)) {
    throw new Error("Plan Mode must be approved before background task execution starts");
  }
}

function containsPlanModeRequest(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) return value.some((item) => containsPlanModeRequest(item, seen));

  const record = value as Record<string, unknown>;
  if (isPlanModePermissionObject(record.permissions)) return true;

  for (const [key, child] of Object.entries(record)) {
    if (isPlanPermissionKey(key) && child === "plan") return true;
    if (containsPlanModeRequest(child, seen)) return true;
  }
  return false;
}

function isPlanModePermissionObject(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { mode?: unknown }).mode === "plan");
}

function isPlanPermissionKey(key: string): boolean {
  return key === "permissionMode" || key === "permission_mode" || key === "runPermissionMode" || key === "run_permission_mode";
}

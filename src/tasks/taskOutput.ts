import { TaskRecord } from "./types.js";

export function taskOutput(task: TaskRecord): string {
  if (task.status === "failed") return task.error ?? "Task failed";
  if (task.output?.trim()) return task.output;
  if (task.result !== undefined) return stringifyResult(task.result);
  return `Task ${task.id} is ${task.status}`;
}

function stringifyResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}

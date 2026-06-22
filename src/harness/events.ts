export type HarnessEvent =
  | { type: "run_started"; workflow_id: string; input: unknown }
  | { type: "node_started"; node_id: string; attempt: number }
  | { type: "node_waiting_user"; node_id: string; questions: unknown[] }
  | { type: "tool_invoked"; node_id: string; tool: string; input: unknown }
  | { type: "tool_completed"; node_id: string; tool: string; result: unknown }
  | { type: "tool_failed"; node_id: string; tool: string; error: string }
  | { type: "artifact_created"; node_id: string; artifact_id: string; path: string }
  | { type: "node_completed"; node_id: string; status: "success" | "failure"; result: unknown }
  | { type: "transition"; from: string; to: string; reason: "success" | "failure" }
  | { type: "run_completed"; result: unknown }
  | { type: "run_failed"; error: string };

export type StoredEvent = HarnessEvent & {
  ts: string;
  seq: number;
};

import { PermissionController } from "../harness/permissionController.js";
import { StoredEvent } from "../harness/events.js";
import { WorkflowState } from "./state.js";
import type { ActiveTurnInputReceipt } from "../runtime/activeTurnInput.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";

export type WorkflowDispatchOptions = {
  reason?: string;
  countsAsRework?: boolean;
  permissionMode?: Exclude<PermissionMode, "plan">;
  destructivePolicy?: "ask" | "deny";
};

export type WorkflowSession = {
  sessionId: string;
  runId: string;
  state: WorkflowState;
  events: AsyncIterable<StoredEvent>;
  replayEventCount?: number;
  permissions: PermissionController;
  interrupt(): Promise<void>;
  resumeWithUserInput(input: unknown): Promise<void>;
  queueUserInput?(input: unknown, inputId?: string): Promise<ActiveTurnInputReceipt>;
  continueWithInput(input: unknown): Promise<void>;
  dispatchToNode(nodeId: string, input: unknown, options?: WorkflowDispatchOptions): Promise<void>;
  finalize(summary: string): Promise<void>;
  subscribeState(listener: (state: WorkflowState) => void): () => void;
  waitForBoundary(): Promise<WorkflowState>;
  result: Promise<WorkflowState>;
};

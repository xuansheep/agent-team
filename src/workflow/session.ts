import { PermissionController } from "../harness/permissionController.js";
import { StoredEvent } from "../harness/events.js";
import { WorkflowState } from "./state.js";
import type { ActiveTurnInputReceipt } from "../runtime/activeTurnInput.js";

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
  result: Promise<WorkflowState>;
};

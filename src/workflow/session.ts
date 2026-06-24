import { PermissionController } from "../harness/permissionController.js";
import { StoredEvent } from "../harness/events.js";
import { WorkflowState } from "./state.js";

export type PlanReviewDecision = "continue" | "stay";

export type WorkflowSession = {
  runId: string;
  state: WorkflowState;
  events: AsyncIterable<StoredEvent>;
  permissions: PermissionController;
  interrupt(): Promise<void>;
  resumeWithUserInput(input: unknown): Promise<void>;
  resumePlanReview(decision: PlanReviewDecision): Promise<void>;
  revisePlan(input: unknown): Promise<void>;
  continueWithInput(input: unknown): Promise<void>;
  result: Promise<WorkflowState>;
};

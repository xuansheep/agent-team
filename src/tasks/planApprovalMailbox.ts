import { randomUUID } from "node:crypto";
import { PlanApprovalRequest } from "../runtime/types.js";

export type TaskPlanApprovalStatus = "pending" | "approved" | "rejected";

export type TaskPlanApproval = {
  id: string;
  requesterTaskId: string;
  plan: PlanApprovalRequest;
  status: TaskPlanApprovalStatus;
  createdAt: string;
  updatedAt: string;
  feedback?: unknown;
};

export class PlanApprovalMailbox {
  private readonly approvals = new Map<string, TaskPlanApproval>();

  submit(input: { requesterTaskId: string; plan: PlanApprovalRequest }): TaskPlanApproval {
    const now = timestamp();
    const approval: TaskPlanApproval = {
      id: randomUUID(),
      requesterTaskId: input.requesterTaskId,
      plan: input.plan,
      status: "pending",
      createdAt: now,
      updatedAt: now
    };
    this.approvals.set(approval.id, approval);
    return clone(approval);
  }

  get(id: string): TaskPlanApproval {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error(`Unknown plan approval ${id}`);
    return clone(approval);
  }

  listPending(): TaskPlanApproval[] {
    return [...this.approvals.values()].filter((approval) => approval.status === "pending").map(clone);
  }

  approve(id: string): TaskPlanApproval {
    return this.resolve(id, "approved");
  }

  reject(id: string, feedback?: unknown): TaskPlanApproval {
    return this.resolve(id, "rejected", feedback);
  }

  private resolve(id: string, status: Exclude<TaskPlanApprovalStatus, "pending">, feedback?: unknown): TaskPlanApproval {
    const current = this.approvals.get(id);
    if (!current) throw new Error(`Unknown plan approval ${id}`);
    if (current.status !== "pending") throw new Error(`Plan approval ${id} is already ${current.status}`);
    const next = { ...current, status, feedback, updatedAt: timestamp() };
    this.approvals.set(id, next);
    return clone(next);
  }
}

function clone(approval: TaskPlanApproval): TaskPlanApproval {
  return { ...approval, plan: { ...approval.plan } };
}

function timestamp(): string {
  return new Date().toISOString();
}

import { randomUUID } from "node:crypto";
import { ModelMessage, ModelProvider } from "../providers/types.js";
import { enterPlanMode, exitPlanMode, PlanSessionState, resolvePlanApproval } from "../plans/planSession.js";
import { writePlan } from "../plans/planFiles.js";
import { RuntimeEvent, RuntimePermissionDecision, RuntimePermissionRequest } from "../runtime/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolPermissionContext } from "../permissions/context.js";
import { headlessQuery, HeadlessQueryResult, normalizePermissions } from "./headless.js";

export type LocalHeadlessSessionOptions = {
  sessionId?: string;
  cwd: string;
  provider: ModelProvider;
  model: string;
  tools?: ToolRegistry;
  permissions?: Partial<ToolPermissionContext>;
  permissionCallback?: (request: RuntimePermissionRequest) => RuntimePermissionDecision | Promise<RuntimePermissionDecision>;
  planApprovalCallback?: (plan: { sessionId: string; document: string; planFilePath: string }) => "continue" | "stay" | Promise<"continue" | "stay">;
  workflowStarter?: (handoff: unknown) => void | Promise<void>;
};

export type PlanApprovalResolution = {
  decision: "continue" | "stay";
  events: RuntimeEvent[];
  planState: PlanSessionState;
};

export class LocalHeadlessSession {
  readonly sessionId: string;
  private messages: ModelMessage[] = [];
  private permissions: ToolPermissionContext;
  private planState?: PlanSessionState;

  constructor(private readonly options: LocalHeadlessSessionOptions) {
    this.sessionId = options.sessionId ?? `sdk-${randomUUID()}`;
    this.permissions = normalizePermissions(options.permissions);
  }

  getMessages(): ModelMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  getPlanState(): PlanSessionState | undefined {
    return this.planState ? { ...this.planState } : undefined;
  }

  async query(content: string): Promise<HeadlessQueryResult> {
    this.messages.push({ role: "user", content });
    const result = await headlessQuery({
      sessionId: this.sessionId,
      messages: this.messages,
      model: this.options.model,
      provider: this.options.provider,
      tools: this.options.tools,
      permissions: this.permissions,
      cwd: this.options.cwd,
      permissionCallback: this.options.permissionCallback
    });
    this.messages = result.messages;
    return result;
  }

  enterPlanMode(originalInput: unknown): RuntimeEvent {
    const entered = enterPlanMode({
      sessionId: this.sessionId,
      cwd: this.options.cwd,
      originalInput,
      permissions: this.permissions
    });
    this.planState = entered.state;
    this.permissions = entered.permissions;
    return entered.event;
  }

  async updatePlanDraft(document: string): Promise<RuntimeEvent> {
    if (!this.planState) throw new Error("Plan Mode is not active");
    await writePlan(this.planState.planFilePath, document);
    return { type: "plan_draft_updated", session_id: this.sessionId, plan_file_path: this.planState.planFilePath };
  }

  async requestPlanApproval(): Promise<PlanApprovalResolution> {
    if (!this.planState) throw new Error("Plan Mode is not active");
    const requested = await exitPlanMode(this.planState);
    this.planState = requested.state;
    const decision = await this.options.planApprovalCallback?.(requested.plan) ?? "stay";
    const approvedState = decision === "continue" ? { ...this.planState, approvedPlan: requested.plan.document } : this.planState;
    const resolved = resolvePlanApproval(approvedState, decision);
    this.planState = resolved.state;
    this.permissions = resolved.permissions;
    if (decision === "continue") {
      await this.options.workflowStarter?.({ original_input: this.planState.originalInput, approved_plan: requested.plan.document });
    }
    return { decision, events: [requested.event, resolved.event], planState: this.planState };
  }
}

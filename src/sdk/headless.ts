import { randomUUID } from "node:crypto";
import { ModelMessage, ModelProvider } from "../providers/types.js";
import { RuntimeTurnExecutor } from "../runtime/turnExecutor.js";
import { PlanApprovalRequest, RuntimeEvent, RuntimePermissionDecision, RuntimePermissionRequest, RuntimeTurnResult } from "../runtime/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolPermissionContext } from "../permissions/context.js";
import { PlanSessionState } from "../plans/planSession.js";

export type HeadlessQueryInput = {
  sessionId?: string;
  messages: ModelMessage[];
  model: string;
  provider: ModelProvider;
  tools?: ToolRegistry;
  permissions?: Partial<ToolPermissionContext>;
  planState?: PlanSessionState;
  cwd: string;
  permissionCallback?: (request: RuntimePermissionRequest) => RuntimePermissionDecision | Promise<RuntimePermissionDecision>;
};

export type HeadlessQueryResult = {
  sessionId: string;
  status: RuntimeTurnResult["status"];
  messages: ModelMessage[];
  events: RuntimeEvent[];
  error?: string;
  plan?: PlanApprovalRequest;
  planState?: PlanSessionState;
};

export async function headlessQuery(input: HeadlessQueryInput): Promise<HeadlessQueryResult> {
  const sessionId = input.sessionId ?? `headless-${randomUUID()}`;
  const events: RuntimeEvent[] = [];
  const permissions = normalizePermissions(input.permissions);
  const result = await new RuntimeTurnExecutor().execute({
    messages: input.messages,
    model: input.model,
    provider: input.provider,
    tools: input.tools ?? new ToolRegistry(),
    permissions: input.planState && permissions.mode === "plan" && !permissions.planFilePath
      ? { ...permissions, planFilePath: input.planState.planFilePath, prePlanMode: input.planState.prePlanMode, planUseAutoMode: input.planState.useAutoModeDuringPlan }
      : permissions,
    cwd: input.cwd,
    sessionId,
    planState: input.planState,
    eventSink: (event) => { events.push(event); },
    permissionCallback: input.permissionCallback
  });
  return {
    sessionId,
    status: result.status,
    messages: result.messages,
    events,
    error: result.status === "failed" ? result.error : undefined,
    ...(result.status === "waiting_plan_approval" ? { plan: result.plan, planState: result.planState } : {})
  };
}

export function normalizePermissions(permissions: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: permissions.mode ?? "default",
    prePlanMode: permissions.prePlanMode,
    allow: permissions.allow ?? [],
    ask: permissions.ask ?? [],
    deny: permissions.deny ?? [],
    source: permissions.source,
    planFilePath: permissions.planFilePath,
    planUseAutoMode: permissions.planUseAutoMode
  };
}

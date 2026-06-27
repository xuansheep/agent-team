import { randomUUID } from "node:crypto";
import { ModelMessage, ModelProvider } from "../providers/types.js";
import { RuntimeTurnExecutor } from "../runtime/turnExecutor.js";
import { RuntimeEvent, RuntimePermissionDecision, RuntimePermissionRequest, RuntimeTurnResult } from "../runtime/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolPermissionContext } from "../permissions/context.js";

export type HeadlessQueryInput = {
  sessionId?: string;
  messages: ModelMessage[];
  model: string;
  provider: ModelProvider;
  tools?: ToolRegistry;
  permissions?: Partial<ToolPermissionContext>;
  cwd: string;
  permissionCallback?: (request: RuntimePermissionRequest) => RuntimePermissionDecision | Promise<RuntimePermissionDecision>;
};

export type HeadlessQueryResult = {
  sessionId: string;
  status: RuntimeTurnResult["status"];
  messages: ModelMessage[];
  events: RuntimeEvent[];
  error?: string;
};

export async function headlessQuery(input: HeadlessQueryInput): Promise<HeadlessQueryResult> {
  const sessionId = input.sessionId ?? `headless-${randomUUID()}`;
  const events: RuntimeEvent[] = [];
  const result = await new RuntimeTurnExecutor().execute({
    messages: input.messages,
    model: input.model,
    provider: input.provider,
    tools: input.tools ?? new ToolRegistry(),
    permissions: normalizePermissions(input.permissions),
    cwd: input.cwd,
    sessionId,
    eventSink: (event) => { events.push(event); },
    permissionCallback: input.permissionCallback
  });
  return {
    sessionId,
    status: result.status,
    messages: result.messages,
    events,
    error: result.status === "failed" ? result.error : undefined
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
    planFilePath: permissions.planFilePath
  };
}

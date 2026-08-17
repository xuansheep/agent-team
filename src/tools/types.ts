import type { AuditSink } from "../audit/auditEvent.js";
import type { PlanSessionState } from "../plans/planSession.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import type { ModelProvider } from "../providers/types.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import type { ToolRegistry } from "./registry.js";

export type ToolContext = {
  cwd: string;
  runDir?: string;
  nodeId?: string;
  attempt?: number;
  activation?: number;
  sessionId?: string;
  runId?: string;
  planState?: PlanSessionState;
  planFilePath?: string;
  abortSignal?: AbortSignal;
  auditSink?: AuditSink;
  provider?: ModelProvider;
  model?: string;
  toolRegistry?: ToolRegistry;
  toolPermissionContext?: ToolPermissionContext;
  permissionMode?: PermissionMode;
  mcpDiscoveredToolNames?: readonly string[];
};

export type ToolResult = {
  output?: string;
  error?: string;
  stderr?: string;
  is_error?: boolean;
  exit_code?: number;
  artifact_id?: string;
  path?: string;
  description?: string;
  data?: unknown;
};

export type ToolSafety = {
  isReadOnly?: (input?: unknown, context?: ToolContext) => boolean;
  isConcurrencySafe?: () => boolean;
  isDestructive?: (input: unknown) => boolean | Promise<boolean>;
  writesPlanFile?: (input: unknown, context: ToolContext) => boolean | Promise<boolean>;
  requiresUserInteraction?: (input: unknown) => boolean | Promise<boolean>;
  requiresPermissionPrompt?: (input: unknown, context: ToolContext) => boolean | Promise<boolean>;
};

export type Tool = ToolSafety & {
  name: string;
  description: string;
  prompt?: string | (() => string);
  input_schema: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  validateInput?: (input: unknown, context: ToolContext) => Promise<{ result: true } | { result: false; message: string }>;
  mapToolResultToModelResult?: (output: ToolResult, context?: ToolContext) => unknown;
};

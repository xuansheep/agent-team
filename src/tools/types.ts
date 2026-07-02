import type { AuditSink } from "../audit/auditEvent.js";
import type { PlanSessionState } from "../plans/planSession.js";

export type ToolContext = {
  cwd: string;
  runDir?: string;
  nodeId?: string;
  attempt?: number;
  sessionId?: string;
  runId?: string;
  planState?: PlanSessionState;
  abortSignal?: AbortSignal;
  auditSink?: AuditSink;
};

export type ToolResult = {
  output?: string;
  error?: string;
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
};

export type Tool = ToolSafety & {
  name: string;
  description: string;
  prompt?: string | (() => string);
  input_schema: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  validateInput?: (input: unknown, context: ToolContext) => Promise<{ result: true } | { result: false; message: string }>;
  mapToolResultToModelResult?: (output: ToolResult) => unknown;
};

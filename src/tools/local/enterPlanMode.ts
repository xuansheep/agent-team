import { z } from "zod";
import { enterPlanMode } from "../../plans/planSession.js";
import { ToolPermissionContext } from "../../permissions/context.js";
import { Tool } from "../types.js";

const inputSchema = z.object({
  sessionId: z.string().min(1),
  originalInput: z.any(),
  permissions: z.object({
    mode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]),
    prePlanMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]).optional(),
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    source: z.enum(["workflow", "session", "settings"]).optional(),
    planFilePath: z.string().optional()
  })
});

export const enterPlanModeTool: Tool = {
  name: "EnterPlanMode",
  description: "Enter session-level Plan Mode before workflow execution.",
  input_schema: { type: "object", properties: { sessionId: { type: "string" }, originalInput: {}, permissions: { type: "object" } }, required: ["sessionId", "originalInput", "permissions"] },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async execute(input, context) {
    const parsed = inputSchema.parse(input) as { sessionId: string; originalInput: unknown; permissions: ToolPermissionContext };
    const result = enterPlanMode({ ...parsed, cwd: context.cwd });
    await context.auditSink?.({
      type: "plan_mode",
      session_id: result.event.session_id,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      action: "entered",
      plan_file_path: result.state.planFilePath
    });
    return { output: `Entered Plan Mode for ${parsed.sessionId}`, data: result };
  }
};

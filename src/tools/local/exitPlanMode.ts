import { z } from "zod";
import { exitPlanMode, PlanSessionState } from "../../plans/planSession.js";
import { Tool } from "../types.js";

const stateSchema = z.object({
  mode: z.enum(["inactive", "planning", "waiting_approval"]),
  sessionId: z.string().min(1),
  planFilePath: z.string().min(1),
  prePlanMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]),
  originalInput: z.any(),
  approvedPlan: z.string().optional(),
  feedbackMessages: z.array(z.any()).optional()
});
const inputSchema = z.object({ state: stateSchema });

export const exitPlanModeTool: Tool = {
  name: "ExitPlanMode",
  description: "Request approval for the current Plan Mode draft.",
  input_schema: { type: "object", properties: { state: { type: "object" } }, required: ["state"] },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async execute(input, context) {
    const parsed = inputSchema.parse(input) as { state: PlanSessionState };
    try {
      const result = await exitPlanMode(parsed.state);
      await context.auditSink?.({
        type: "plan_mode",
        session_id: result.event.session_id,
        run_id: context.runId,
        node_id: context.nodeId,
        attempt: context.attempt,
        action: "approval_requested",
        plan_file_path: result.plan.planFilePath
      });
      return { output: `Plan approval requested for ${result.plan.sessionId}`, data: result };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), exit_code: 1 };
    }
  }
};

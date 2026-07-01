import { z } from "zod";
import { exitPlanMode, PlanRequestedPermission, PlanSessionState } from "../../plans/planSession.js";
import { Tool } from "../types.js";

const stateSchema = z.object({
  mode: z.enum(["inactive", "planning", "waiting_approval"]),
  sessionId: z.string().min(1),
  planFilePath: z.string().min(1),
  prePlanMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]),
  originalInput: z.any(),
  approvedPlan: z.string().optional(),
  emptyPlanApproved: z.boolean().optional(),
  feedbackMessages: z.array(z.any()).optional()
});
const allowedPromptSchema = z.object({
  tool: z.literal("Bash"),
  prompt: z.string().min(1)
});
const inputSchema = z.object({
  state: stateSchema.optional(),
  allowedPrompts: z.array(allowedPromptSchema).optional()
}).default({});

export const EXIT_PLAN_MODE_TOOL_PROMPT = `Use this tool when you are in plan mode, have finished updating the current plan file, and are ready for user approval.

## How This Tool Works
- This tool does not accept plan text as input
- The plan shown to the user is read from the current plan file
- Before calling this tool, write or update the current plan file with Write, Edit, or MultiEdit
- This tool signals that you're done planning and ready for the user to review and approve

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning implementation steps for a task that requires writing code. For pure research or codebase exploration tasks, do NOT use this tool.

## Before Using This Tool
Ensure your plan file is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first
- Once the plan file is finalized, use this tool with no plan text to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of the plan file.
`;


export const exitPlanModeTool: Tool = {
  name: "ExitPlanMode",
  description: "Prompts the user to exit plan mode and start coding",
  prompt: EXIT_PLAN_MODE_TOOL_PROMPT,
  input_schema: {
    type: "object",
    properties: {
      allowedPrompts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", enum: ["Bash"] },
            prompt: { type: "string" }
          },
          required: ["tool", "prompt"]
        }
      }    }
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  requiresUserInteraction: () => true,
  mapToolResultToModelResult: (result) => exitPlanModePendingApprovalMessage(result),
  async execute(input, context) {
    const parsed = inputSchema.parse(input) as { state?: PlanSessionState; allowedPrompts?: PlanRequestedPermission[] };
    const state = parsed.state ?? context.planState;
    if (!state) return { error: "Plan Mode is not active", exit_code: 1 };
    try {
      const result = await exitPlanMode(state, { requestedPermissions: parsed.allowedPrompts });
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

function exitPlanModePendingApprovalMessage(result: { output?: string; error?: string; data?: unknown }): string | undefined {
  if (result.error) return result.error;
  const data = result.data as { plan?: { document?: unknown; planFilePath?: unknown; empty?: unknown } } | undefined;
  const plan = data?.plan;
  if (!plan) return result.output;
  const planFilePath = typeof plan.planFilePath === "string" && plan.planFilePath.trim() ? plan.planFilePath.trim() : undefined;
  const savedLine = planFilePath ? ` The plan file is saved at: ${planFilePath}.` : "";
  if (plan.empty === true || (typeof plan.document === "string" && !plan.document.trim())) {
    return `Exit Plan Mode has requested user approval without a written plan.${savedLine} Wait for the user's approval or feedback before proceeding.`;
  }
  return `Plan approval has been requested from the user.${savedLine} Wait for the user's approval or feedback before proceeding.`;
}

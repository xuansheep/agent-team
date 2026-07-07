import { z } from "zod";
import { exitPlanMode, PlanRequestedPermission, PlanSessionState } from "../../plans/planSession.js";
import { Tool } from "../types.js";

const stateSchema = z.object({
  mode: z.enum(["inactive", "planning", "waiting_approval"]),
  sessionId: z.string().min(1),
  planFilePath: z.string().min(1),
  prePlanMode: z.enum(["default", "fullAccess", "plan"]),
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

export const EXIT_PLAN_MODE_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it does not accept plan text as input and will read from the current plan file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
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
  const data = result.data as { plan?: { planFilePath?: unknown; empty?: unknown } } | undefined;
  const plan = data?.plan;
  if (!plan) return result.output;
  const planFilePath = typeof plan.planFilePath === "string" && plan.planFilePath.trim() ? plan.planFilePath.trim() : undefined;
  const savedLine = planFilePath ? ` The plan file is saved at: ${planFilePath}.` : "";
  if (plan.empty === true) {
    return `Exit Plan Mode has requested user approval without a written plan.${savedLine} Wait for the user's approval or feedback before proceeding.`;
  }
  return `Plan approval has been requested from the user.${savedLine} Wait for the user's approval or feedback before proceeding.`;
}

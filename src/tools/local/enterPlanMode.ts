import { z } from "zod";
import { enterPlanMode } from "../../plans/planSession.js";
import { ToolPermissionContext } from "../../permissions/context.js";
import { Tool } from "../types.js";

const inputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  originalInput: z.any().optional(),
  permissions: z.object({
    mode: z.enum(["default", "fullAccess", "plan"]),
    prePlanMode: z.enum(["default", "fullAccess", "plan"]).optional(),
    allow: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    source: z.enum(["workflow", "session", "settings"]).optional(),
    planFilePath: z.string().optional()
  }).optional()
});

export const enterPlanModeTool: Tool = {
  name: "EnterPlanMode",
  description: "Requests permission to enter plan mode for complex tasks requiring exploration and design",
  prompt: getEnterPlanModeToolPrompt,
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  mapToolResultToModelResult: (result) => enterPlanModeInstructions(result.output),
  async execute(input, context) {
    const parsed = inputSchema.parse(input) as { sessionId?: string; originalInput?: unknown; permissions?: ToolPermissionContext };
    if (!parsed.sessionId && !parsed.permissions) {
      if (!context.planState) return { output: enterPlanModeInstructions() };
      return {
        output: enterPlanModeInstructions(),
        data: {
          state: context.planState,
          permissions: {
            mode: "plan",
            prePlanMode: context.planState.prePlanMode,
            allow: [],
            ask: [],
            deny: [],
            planFilePath: context.planState.planFilePath
          }
        }
      };
    }
    if (!parsed.sessionId || parsed.originalInput === undefined || !parsed.permissions) {
      return { error: "EnterPlanMode legacy input requires sessionId, originalInput, and permissions", exit_code: 1 };
    }
    const result = enterPlanMode({ sessionId: parsed.sessionId, originalInput: parsed.originalInput, permissions: parsed.permissions, cwd: context.cwd });
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

export function getEnterPlanModeToolPrompt(): string {
  return `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (perform read-only exploration instead)

## What Happens in Plan Mode

In plan mode, you'll follow the default 5-phase workflow:
1. Phase 1: Initial Understanding - inspect relevant code, configs, tests, and docs with read-only tools
2. Phase 2: Design - form one recommended implementation approach from the discovered context
3. Phase 3: Review - verify the approach against the user's intent and ask clarifying questions only when needed
4. Phase 4: Final Plan - write a decision-complete markdown plan to the current plan file
5. Phase 5: Call ExitPlanMode - request approval only after the current plan file contains the complete plan

Keep all planning edits in the current plan file; source files are forbidden and only the current plan file is editable

## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase
`;
}

function enterPlanModeInstructions(message = "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach."): string {
  return [
    message,
    "",
    "In plan mode, follow the default 5-phase workflow:",
    "1. Phase 1: Initial Understanding - inspect relevant code, configs, tests, and docs with read-only tools",
    "2. Phase 2: Design - form one recommended implementation approach from the discovered context",
    "3. Phase 3: Review - verify the approach against the user's intent and use AskUserQuestion only when clarification is needed",
    "4. Phase 4: Final Plan - write a decision-complete markdown plan to the current plan file",
    "5. Phase 5: Call ExitPlanMode - request approval only after the current plan file contains the complete plan",
    "",
    "Remember: source files are forbidden in plan mode; only the current plan file is editable. All other exploration must be read-only."
  ].join("\n");
}

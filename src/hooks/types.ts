import { z } from "zod";

export const hookEvents = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged"
] as const;

export type HookEvent = typeof hookEvents[number];

const hookEventSet = new Set<string>(hookEvents);

const hookBaseSchema = {
  if: z.string().min(1).optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().min(1).optional(),
  once: z.boolean().optional()
};

export const hookCommandSchema = z.discriminatedUnion("type", [
  z.object({
    ...hookBaseSchema,
    type: z.literal("command"),
    command: z.string().min(1),
    shell: z.enum(["bash", "sh", "cmd", "powershell", "pwsh"]).optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional()
  }).strict(),
  z.object({
    ...hookBaseSchema,
    type: z.literal("prompt"),
    prompt: z.string().min(1),
    model: z.string().min(1).optional()
  }).strict(),
  z.object({
    ...hookBaseSchema,
    type: z.literal("agent"),
    prompt: z.string().min(1),
    model: z.string().min(1).optional()
  }).strict(),
  z.object({
    ...hookBaseSchema,
    type: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string()).optional()
  }).strict()
]);

export const hookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema)
}).strict();

export const hooksSettingsSchema = z.record(z.array(hookMatcherSchema)).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (!hookEventSet.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Unknown hook event ${key}`
      });
    }
  }
});

export type HookCommand = z.infer<typeof hookCommandSchema>;
export type HookMatcher = z.infer<typeof hookMatcherSchema>;
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>;

export type FunctionHook = {
  type: "function";
  id?: string;
  timeout?: number;
  statusMessage?: string;
  once?: boolean;
  callback(input: HookInput, signal?: AbortSignal): boolean | HookJSONOutput | Promise<boolean | HookJSONOutput>;
  errorMessage?: string;
};

export type RuntimeHook = HookCommand | FunctionHook;

export type HookInput = Record<string, unknown> & {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
};

export type HookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: HookEvent;
    permissionDecision?: "allow" | "deny" | "ask";
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    updatedMCPToolOutput?: unknown;
    [key: string]: unknown;
  };
};

export type HookRunResult = {
  event: HookEvent;
  executed: number;
  blockingErrors: Array<{ blockingError: string; command: string }>;
  nonBlockingErrors: string[];
  additionalContexts: string[];
  systemMessages: string[];
  preventContinuation?: boolean;
  stopReason?: string;
  permissionBehavior?: "allow" | "deny" | "ask";
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
};

export function isHookEvent(value: string): value is HookEvent {
  return hookEventSet.has(value);
}

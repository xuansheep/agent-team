import { z } from "zod";

export const sdkPermissionDecisionSchema = z.enum(["allow", "deny"]);
export const sdkPlanDecisionSchema = z.enum(["continue", "stay"]);

export const sdkQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.unknown())]),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })).optional()
  }).passthrough()),
  cwd: z.string().min(1),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]).default("default")
});

export type SdkPermissionDecision = z.infer<typeof sdkPermissionDecisionSchema>;
export type SdkPlanDecision = z.infer<typeof sdkPlanDecisionSchema>;
export type SdkQuerySchema = z.infer<typeof sdkQuerySchema>;

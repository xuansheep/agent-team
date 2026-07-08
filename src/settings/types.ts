import { z } from "zod";
import { hooksSettingsSchema } from "../hooks/types.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";

export const settingsPermissionModeSchema = z.enum(["default", "fullAccess", "plan"]);

export const settingsSchema = z.object({
  permissions: z.object({
    defaultMode: settingsPermissionModeSchema.optional()
  }).strict().optional(),
  plansDirectory: z.string().min(1).optional(),
  models: z.object({
    planModel: z.string().min(1).optional(),
    aliases: z.record(z.string().min(1)).optional(),
    contextWindows: z.record(z.number().int().positive()).optional()
  }).strict().optional(),
  planMode: z.object({
    defaultEntry: z.boolean().optional()
  }).strict().optional(),
  agentsMdExcludes: z.array(z.string().min(1)).optional(),
  hasAgentsMdExternalIncludesApproved: z.boolean().optional(),
  hasAgentsMdExternalIncludesWarningShown: z.boolean().optional(),
  showClearContextOnPlanAccept: z.boolean().optional(),
  hooks: hooksSettingsSchema.optional()
}).strict();

export type AgentTeamSettings = z.infer<typeof settingsSchema>;

export type ResolvedAgentTeamSettings = Omit<AgentTeamSettings, "permissions"> & {
  permissions?: {
    defaultMode?: PermissionMode;
  };
};

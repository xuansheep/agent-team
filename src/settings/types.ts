import { z } from "zod";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import { providerSchema } from "../config/schema.js";
import { mcpServersSettingsSchema } from "../mcp/schema.js";

export const settingsPermissionModeSchema = z.enum(["default", "fullAccess", "plan"]);

const settingsShape = {
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
  copyOnSelect: z.boolean().optional(),
  showClearContextOnPlanAccept: z.boolean().optional()
};

export const mcpProjectStateSchema = z.object({
  disabledMcpServers: z.array(z.string().min(1)).optional(),
  enabledMcpServers: z.array(z.string().min(1)).optional()
}).strict();

export const projectSettingsSchema = z.object({
  ...settingsShape,
  mcpServers: mcpServersSettingsSchema.optional()
}).strict();

export const settingsSchema = z.object({
  ...settingsShape,
  providers: z.record(providerSchema).optional(),
  mcpServers: mcpServersSettingsSchema.optional(),
  projects: z.record(mcpProjectStateSchema).optional()
}).strict();

export type AgentTeamSettings = z.infer<typeof settingsSchema>;
export type ProjectAgentTeamSettings = z.infer<typeof projectSettingsSchema>;

export type McpProjectState = z.infer<typeof mcpProjectStateSchema>;

export type ResolvedAgentTeamSettings = Omit<AgentTeamSettings, "permissions" | "mcpServers" | "projects"> & {
  permissions?: {
    defaultMode?: PermissionMode;
  };
};

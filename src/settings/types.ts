import { z } from "zod";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import { providerSettingsSchema, type ResolvedProviderConfig } from "../config/schema.js";
import { mcpServersSettingsSchema } from "../mcp/schema.js";

export const settingsPermissionModeSchema = z.enum(["default", "fullAccess", "plan"]);

export const statusLineElementIds = [
  "run-state",
  "permission",
  "current-dir",
  "git-branch",
  "workflow",
  "run-id",
  "tokens-io",
  "tokens-cache",
  "requests",
  "selection"
] as const;

export const statusLineElementSchema = z.enum(statusLineElementIds);
export type StatusLineElement = z.infer<typeof statusLineElementSchema>;

export const defaultStatusLineElements: StatusLineElement[] = [
  "run-state",
  "permission",
  "current-dir",
  "git-branch",
  "tokens-io",
  "tokens-cache",
  "run-id",
  "selection"
];

const statusLineSchema = z.preprocess(
  (value) => Array.isArray(value)
    ? value.filter((element) => element !== "mode" && element !== "work-mode" && element !== "loading")
    : value,
  z.array(statusLineElementSchema).refine(
    (elements) => new Set(elements).size === elements.length,
    "Status line elements must be unique"
  )
);

const settingsShape = {
  permissions: z.object({
    defaultMode: settingsPermissionModeSchema.optional()
  }).strict().optional(),
  plansDirectory: z.string().min(1).optional(),
  models: z.object({
    planModel: z.string().min(1).optional(),
    defaultContextWindow: z.number().int().positive().optional(),
    aliases: z.record(z.string().min(1)).optional(),
    contextWindows: z.record(z.number().int().positive()).optional(),
    defaultAutoCompactTokenLimit: z.number().int().positive().optional(),
    autoCompactTokenLimits: z.record(z.number().int().positive()).optional(),
    compactionHashes: z.record(z.string().min(1)).optional(),
    autoCompactTokenLimitScope: z.enum(["total", "body_after_prefix"]).optional(),
    toolOutputTokenLimit: z.number().int().positive().optional(),
    compactPrompt: z.string().min(1).optional(),
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
  enabledMcpServers: z.array(z.string().min(1)).optional(),
  disabledSkills: z.array(z.string().min(1)).optional()
}).strict();

export const projectSettingsSchema = z.object({
  ...settingsShape,
  mcpServers: mcpServersSettingsSchema.optional()
}).strict();

export const settingsSchema = z.object({
  ...settingsShape,
  statusLine: statusLineSchema.optional(),
  providers: z.record(providerSettingsSchema).optional(),
  mcpServers: mcpServersSettingsSchema.optional(),
  projects: z.record(mcpProjectStateSchema).optional()
}).strict();

export type AgentTeamSettings = z.infer<typeof settingsSchema>;
export type ProjectAgentTeamSettings = z.infer<typeof projectSettingsSchema>;

export type McpProjectState = z.infer<typeof mcpProjectStateSchema>;

export type ResolvedAgentTeamSettings = Omit<AgentTeamSettings, "permissions" | "providers" | "mcpServers" | "projects"> & {
  providers?: Record<string, ResolvedProviderConfig>;
  permissions?: {
    defaultMode?: PermissionMode;
  };
};

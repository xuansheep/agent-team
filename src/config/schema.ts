import { z } from "zod";

export const permissionSetSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([])
}).default({ allow: [], ask: [], deny: [] });

export const providerSchema = z.object({
  type: z.literal("openai-compatible"),
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  default_model: z.string().min(1),
  capabilities: z.object({
    tool_calling: z.boolean().default(false),
    vision: z.boolean().default(false),
    streaming: z.boolean().default(false),
    json_schema_output: z.boolean().default(true)
  }).default({})
});

export const roleSchema = z.object({
  description: z.string().default(""),
  system_prompt: z.string().min(1),
  default_model: z.string().optional(),
  requires: z.object({
    tool_calling: z.boolean().default(false),
    vision: z.boolean().default(false)
  }).default({})
});

export const nodeSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  provider: z.string().default("default"),
  model: z.string().optional(),
  permission_mode: z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]).default("default"),
  permissions: permissionSetSchema.optional()
});

export const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.enum(["success", "failure"]).default("success")
});

export const workflowSchema = z.object({
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  workflow_permissions: permissionSetSchema.optional()
});

export const configSchema = z.object({
  providers: z.record(providerSchema),
  roles: z.record(roleSchema),
  workflows: z.record(workflowSchema)
});

export type AgentTeamConfig = z.infer<typeof configSchema>;
export type WorkflowConfig = z.infer<typeof workflowSchema>;
export type WorkflowNodeConfig = z.infer<typeof nodeSchema>;
export type PermissionSet = z.infer<typeof permissionSetSchema>;

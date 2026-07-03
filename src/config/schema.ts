import { z } from "zod";

export const permissionSetSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([])
}).default({ allow: [], ask: [], deny: [] });

export const apiKeyModeSchema = z.enum(["bearer", "x-api-key"]);

const providerCapabilitiesSchema = z.object({
  tool_calling: z.boolean().default(false),
  vision: z.boolean().default(false),
  streaming: z.boolean().default(false),
  json_schema_output: z.boolean().default(true)
});

const providerBaseSchema = {
  base_url: z.string().url(),
  api_key_env: z.string().min(1),
  default_model: z.string().min(1),
  plan_model: z.string().min(1).optional(),
  model_aliases: z.record(z.string().min(1)).optional(),
  context_windows: z.record(z.number().int().positive()).optional(),
  api_key_mode: apiKeyModeSchema.default("bearer"),
  user_agent: z.string().min(1).optional(),
  capabilities: providerCapabilitiesSchema.default({})
};

const openAiCompatibleProviderSchema = z.object({
  type: z.literal("openai-compatible"),
  ...providerBaseSchema
});

const responsesProviderSchema = z.object({
  type: z.literal("responses-api"),
  ...providerBaseSchema,
  responses: z.object({
    prompt_cache: z.boolean().default(true),
    parallel_tool_calls: z.boolean().default(true),
    reasoning: z.object({
      effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
      summary: z.string().optional()
    }).optional()
  }).default({})
});

const anthropicProviderSchema = z.object({
  type: z.literal("anthropic"),
  ...providerBaseSchema,
  api_key_mode: apiKeyModeSchema.default("x-api-key"),
  anthropic: z.object({
    version: z.string().min(1).default("2023-06-01"),
    beta_headers: z.array(z.string().min(1)).default([]),
    max_tokens: z.number().int().positive().default(8192),
    prompt_cache: z.boolean().default(true),
    thinking: z.object({
      type: z.enum(["disabled", "enabled"]).default("disabled"),
      budget_tokens: z.number().int().positive().optional()
    }).default({})
  }).default({})
});

export const providerSchema = z.discriminatedUnion("type", [
  openAiCompatibleProviderSchema,
  responsesProviderSchema,
  anthropicProviderSchema
]);

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
  mode: z.enum(["task", "complete"]).default("task"),
  permission_mode: z.enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]).default("default"),
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
  global_prompt_file: z.string().min(1).optional(),
  global_prompt: z.string().optional(),
  providers: z.record(providerSchema),
  roles: z.record(roleSchema),
  workflows: z.record(workflowSchema)
});

type ParsedAgentTeamConfig = z.infer<typeof configSchema>;
type ParsedProviderConfig = z.infer<typeof providerSchema>;
type ParsedWorkflowConfig = z.infer<typeof workflowSchema>;
type ParsedWorkflowNodeConfig = z.infer<typeof nodeSchema>;
type ProviderConfig = ParsedProviderConfig extends infer Provider
  ? Provider extends { api_key_mode: infer Mode }
    ? Omit<Provider, "api_key_mode"> & { api_key_mode?: Mode }
    : Provider
  : never;

export type GlobalPromptSourceKind = "user_agents" | "project_agents" | "configured_file" | "configured_inline";
export type GlobalPromptSourceMetadata = {
  kind: GlobalPromptSourceKind;
  path?: string;
  sha256: string;
  chars: number;
  lines: number;
};
export type GlobalPromptMetadata = {
  sha256: string;
  chars: number;
  lines: number;
  sources: GlobalPromptSourceMetadata[];
};
export type WorkflowNodeMode = "task" | "complete";
export type WorkflowNodeConfig = Omit<ParsedWorkflowNodeConfig, "mode"> & { mode?: WorkflowNodeMode };
export type WorkflowConfig = Omit<ParsedWorkflowConfig, "nodes"> & { nodes: WorkflowNodeConfig[] };
export type AgentTeamConfig = Omit<ParsedAgentTeamConfig, "providers" | "workflows"> & {
  providers: Record<string, ProviderConfig>;
  workflows: Record<string, WorkflowConfig>;
  global_prompt_metadata?: GlobalPromptMetadata;
};
export type PermissionSet = z.infer<typeof permissionSetSchema>;

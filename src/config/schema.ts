import { z } from "zod";

export const DEFAULT_MAX_REWORK_CYCLES = 99;
export const DEFAULT_REQUEST_MAX_RETRIES = 10;
export const DEFAULT_STREAM_MAX_RETRIES = 10;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

export const permissionSetSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([])
}).default({ allow: [], ask: [], deny: [] });

export const apiKeyModeSchema = z.enum(["bearer", "x-api-key"]);

const providerCapabilitiesSettingsSchema = z.object({
  tool_calling: z.boolean().optional(),
  vision: z.boolean().optional(),
  streaming: z.boolean().optional(),
  json_schema_output: z.boolean().optional()
});

function resolvedProviderCapabilitiesSchema(defaults: {
  tool_calling: boolean;
  vision: boolean;
  streaming: boolean;
  json_schema_output: boolean;
}) {
  return z.object({
    tool_calling: z.boolean().default(defaults.tool_calling),
    vision: z.boolean().default(defaults.vision),
    streaming: z.boolean().default(defaults.streaming),
    json_schema_output: z.boolean().default(defaults.json_schema_output)
  }).default(defaults);
}

const providerCommonShape = {
  base_url: z.string().url(),
  api_key: z.string(),
  default_model: z.string().min(1),
  plan_model: z.string().min(1).optional(),
  model_aliases: z.record(z.string().min(1)).optional(),
  context_windows: z.record(z.number().int().positive()).optional(),
  default_context_window: z.number().int().positive().optional(),
  default_auto_compact_token_limit: z.number().int().positive().optional(),
  auto_compact_token_limits: z.record(z.number().int().positive()).optional(),
  compaction_hashes: z.record(z.string().min(1)).optional(),
  auto_compact_token_limit_scope: z.enum(["total", "body_after_prefix"]).optional(),
  tool_output_token_limit: z.number().int().positive().optional(),
  compact_prompt: z.string().min(1).optional(),
  user_agent: z.string().min(1).optional()
};

const providerSettingsBaseShape = {
  ...providerCommonShape,
  effort: z.string().trim().min(1).optional(),
  request_max_retries: z.number().int().min(0).max(100).optional(),
  stream_max_retries: z.number().int().min(0).max(100).optional(),
  request_timeout_ms: z.number().int().positive().optional(),
  stream_idle_timeout_ms: z.number().int().positive().optional(),
  api_key_mode: apiKeyModeSchema.optional(),
  capabilities: providerCapabilitiesSettingsSchema.optional()
};

const providerBaseSchema = {
  ...providerCommonShape,
  effort: z.string().trim().min(1).default("medium"),
  request_max_retries: z.number().int().min(0).max(100).default(DEFAULT_REQUEST_MAX_RETRIES),
  stream_max_retries: z.number().int().min(0).max(100).default(DEFAULT_STREAM_MAX_RETRIES),
  request_timeout_ms: z.number().int().positive().default(DEFAULT_REQUEST_TIMEOUT_MS),
  stream_idle_timeout_ms: z.number().int().positive().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  api_key_mode: apiKeyModeSchema.default("bearer")
};

const openAiCompatibleProviderSchema = z.object({
  type: z.literal("openai-compatible"),
  ...providerBaseSchema,
  capabilities: resolvedProviderCapabilitiesSchema({
    tool_calling: false,
    vision: false,
    streaming: false,
    json_schema_output: true
  })
}).strict();

const responsesProviderSchema = z.object({
  type: z.literal("responses-api"),
  ...providerBaseSchema,
  capabilities: resolvedProviderCapabilitiesSchema({
    tool_calling: true,
    vision: true,
    streaming: true,
    json_schema_output: true
  }),
  responses: z.object({
    prompt_cache: z.boolean().default(true),
    parallel_tool_calls: z.boolean().default(true),
    reasoning: z.object({
      summary: z.string().optional()
    }).strict().optional()
  }).default({})
}).strict();

const anthropicProviderSchema = z.object({
  type: z.literal("anthropic"),
  ...providerBaseSchema,
  api_key_mode: apiKeyModeSchema.default("x-api-key"),
  capabilities: resolvedProviderCapabilitiesSchema({
    tool_calling: true,
    vision: true,
    streaming: true,
    json_schema_output: true
  }),
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
}).strict();

export const providerSchema = z.discriminatedUnion("type", [
  openAiCompatibleProviderSchema,
  responsesProviderSchema,
  anthropicProviderSchema
]);

const openAiCompatibleProviderSettingsSchema = z.object({
  type: z.literal("openai-compatible"),
  ...providerSettingsBaseShape
}).strict();

const responsesProviderSettingsSchema = z.object({
  type: z.literal("responses-api"),
  ...providerSettingsBaseShape,
  responses: z.object({
    prompt_cache: z.boolean().optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z.object({
      summary: z.string().optional()
    }).strict().optional()
  }).strict().optional()
}).strict();

const anthropicProviderSettingsSchema = z.object({
  type: z.literal("anthropic"),
  ...providerSettingsBaseShape,
  anthropic: z.object({
    version: z.string().min(1).optional(),
    beta_headers: z.array(z.string().min(1)).optional(),
    max_tokens: z.number().int().positive().optional(),
    prompt_cache: z.boolean().optional(),
    thinking: z.object({
      type: z.enum(["disabled", "enabled"]).optional(),
      budget_tokens: z.number().int().positive().optional()
    }).strict().optional()
  }).strict().optional()
}).strict();

export const providerSettingsSchema = z.discriminatedUnion("type", [
  openAiCompatibleProviderSettingsSchema,
  responsesProviderSettingsSchema,
  anthropicProviderSettingsSchema
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

export const roleFrontmatterSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1)
}).strict();

export const nodeSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  provider: z.string().default("default"),
  model: z.string().optional(),
  effort: z.string().trim().min(1).optional(),
  mode: z.enum(["task", "complete"]).default("task"),
  permission_mode: z.enum(["default", "fullAccess"]).default("default"),
  permissions: permissionSetSchema.optional()
});

export const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.enum(["success", "failure"]).default("success")
});

export const workflowSchema = z.object({
  description: z.string().trim().optional(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  max_rework_cycles: z.number().int().positive().default(DEFAULT_MAX_REWORK_CYCLES),
  workflow_permissions: permissionSetSchema.optional()
});

export const workflowFileSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  nodes: z.array(nodeSchema).min(1),
  max_rework_cycles: z.number().int().positive().default(DEFAULT_MAX_REWORK_CYCLES),
  workflow_permissions: permissionSetSchema.optional()
}).strict();

export const configSchema = z.object({
  global_prompt: z.string().optional(),
  roles: z.record(roleSchema),
  workflows: z.record(workflowSchema)
}).strict();

type ParsedProjectConfig = z.infer<typeof configSchema>;
type ParsedProviderConfig = z.infer<typeof providerSchema>;
type ParsedWorkflowConfig = z.infer<typeof workflowSchema>;
type ParsedWorkflowNodeConfig = z.infer<typeof nodeSchema>;
type ProviderDefaults = "effort" | "api_key_mode" | "request_max_retries" | "stream_max_retries" | "request_timeout_ms" | "stream_idle_timeout_ms";
export type ProviderConfig = ParsedProviderConfig extends infer Provider
  ? Provider extends Record<ProviderDefaults, unknown>
    ? Omit<Provider, ProviderDefaults> & Partial<Pick<Provider, ProviderDefaults>>
    : Provider
  : never;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ResolvedProviderConfig = ParsedProviderConfig;

export type GlobalPromptSourceKind = "managed_agents" | "user_agents" | "project_agents" | "local_agents" | "configured_file";
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
export type WorkflowConfig = Omit<ParsedWorkflowConfig, "nodes" | "max_rework_cycles"> & { nodes: WorkflowNodeConfig[]; max_rework_cycles?: number };
export type AgentTeamConfig = Omit<ParsedProjectConfig, "workflows"> & {
  providers: Record<string, ProviderConfig>;
  workflows: Record<string, WorkflowConfig>;
  global_prompt_metadata?: GlobalPromptMetadata;
};
export type PermissionSet = z.infer<typeof permissionSetSchema>;

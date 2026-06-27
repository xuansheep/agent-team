import { z } from "zod";

export const pluginCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  argumentHint: z.string().min(1).optional(),
  prompt: z.string().min(1).optional()
}).strict();

export const pluginToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.unknown()).default({}),
  readOnly: z.boolean().default(false),
  destructive: z.boolean().default(false),
  response: z.string().optional()
}).strict();

export const pluginSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  prompt: z.string().min(1)
}).strict();

export const pluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  commands: z.array(pluginCommandSchema).default([]),
  tools: z.array(pluginToolSchema).default([]),
  skills: z.array(pluginSkillSchema).default([])
}).strict();

export type PluginCommandManifest = z.infer<typeof pluginCommandSchema>;
export type PluginToolManifest = z.infer<typeof pluginToolSchema>;
export type PluginSkillManifest = z.infer<typeof pluginSkillSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

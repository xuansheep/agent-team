import { z } from "zod";

const commonServerFields = {
  disabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
};

const stdioInputSchema = z.object({
  ...commonServerFields,
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional()
}).strict();

export const stdioMcpServerSchema = stdioInputSchema.transform((value) => ({ ...value, type: "stdio" as const }));

function remoteServerSchema(url: z.ZodString) {
  return z.object({
    ...commonServerFields,
    type: z.enum(["http", "sse", "ws"]),
    url,
    headers: z.record(z.string()).optional()
  }).strict();
}

export const remoteMcpServerSchema = remoteServerSchema(z.string().url());
export const mcpServerSchema = z.union([stdioMcpServerSchema, remoteMcpServerSchema]);
export const mcpServersSchema = z.record(mcpServerSchema);
export const mcpServersSettingsSchema = z.record(z.union([
  stdioMcpServerSchema,
  remoteServerSchema(z.string().min(1))
]));

export type StdioMcpServerConfig = z.infer<typeof stdioMcpServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteMcpServerSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServersConfig = z.infer<typeof mcpServersSchema>;
export type McpConfigSource = "managed" | "user" | "project" | "local";

export type ResolvedMcpServerConfig = McpServerConfig & {
  name: string;
  source: McpConfigSource;
  sourcePath?: string;
  sourceFormat?: "json";
};

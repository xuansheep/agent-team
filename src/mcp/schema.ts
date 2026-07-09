import { z } from "zod";

const commonServerFields = {
  disabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
};

export const stdioMcpServerSchema = z.object({
  ...commonServerFields,
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional()
}).strict();

export const remoteMcpServerSchema = z.object({
  ...commonServerFields,
  type: z.enum(["http", "sse", "ws"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional()
}).strict();

export const mcpServerSchema = z.discriminatedUnion("type", [
  stdioMcpServerSchema,
  remoteMcpServerSchema
]);

export const mcpServersSchema = z.record(mcpServerSchema);

export type StdioMcpServerConfig = z.infer<typeof stdioMcpServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteMcpServerSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServersConfig = z.infer<typeof mcpServersSchema>;

export type ResolvedMcpServerConfig = McpServerConfig & {
  name: string;
  source: "user" | "project" | "agent-team";
  sourcePath?: string;
  sourceFormat?: "json" | "yaml";
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
};

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export type McpToolCallResult = {
  content?: McpToolContent[];
  data?: unknown;
  isError?: boolean;
  error?: string;
};

export type McpClient = {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, input: unknown): Promise<McpToolCallResult>;
};

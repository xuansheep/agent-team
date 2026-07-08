export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
};

export type McpTool = McpToolDefinition;

export type McpToolContent =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export type McpToolCallResult = {
  content?: McpToolContent[];
  data?: unknown;
  isError?: boolean;
  error?: string;
};

export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent =
  | { type: "text"; text: string; mimeType?: string }
  | { type: "blob"; blob: string; mimeType?: string };

export type McpPrompt = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpPromptMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type McpClient = {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<{ uri: string; contents: McpResourceContent[] } | unknown>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args: Record<string, unknown>): Promise<{ name: string; messages: McpPromptMessage[] } | unknown>;
  close?(): Promise<void>;
};

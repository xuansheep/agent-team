export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
};

export type McpToolDefinition = McpTool;

export type McpToolContent =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: "image" | "audio"; data: string; mimeType: string; [key: string]: unknown }
  | { type: "resource" | "resource_link"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type McpToolCallResult = {
  content?: McpToolContent[];
  structuredContent?: Record<string, unknown>;
  data?: unknown;
  error?: string;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpResource = {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type McpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type McpResourceContent =
  | { uri: string; text: string; mimeType?: string; _meta?: Record<string, unknown> }
  | { uri: string; blob: string; mimeType?: string; _meta?: Record<string, unknown> };

export type McpPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  _meta?: Record<string, unknown>;
};

export type McpPromptMessage = {
  role: "user" | "assistant";
  content: McpToolContent;
};

export type McpServerMetadata = {
  capabilities?: Record<string, unknown>;
  serverInfo?: { name: string; version: string; title?: string; [key: string]: unknown };
  instructions?: string;
};

export type McpListChangedHandlers = {
  tools?: (tools: McpTool[]) => void | Promise<void>;
  resources?: (resources: McpResource[]) => void | Promise<void>;
  prompts?: (prompts: McpPrompt[]) => void | Promise<void>;
};

export type McpClient = {
  initialize?(): Promise<void>;
  getMetadata?(): McpServerMetadata;
  onListChanged?(handlers: McpListChangedHandlers): void;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
  listResources(): Promise<McpResource[]>;
  listResourceTemplates?(): Promise<McpResourceTemplate[]>;
  readResource(uri: string): Promise<unknown>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
};
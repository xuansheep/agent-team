import { Tool } from "../tools/types.js";

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: "image/png" | "image/jpeg" | "image/webp"; data: string };

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ModelContentPart[];
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
};

export type ModelToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ModelRequestContext = {
  runId: string;
  nodeId: string;
  attempt: number;
  sessionId: string;
  threadId: string;
  turnId: string;
  promptCacheKey: string;
};

export type ModelRequest = {
  model: string;
  messages: ModelMessage[];
  tools: Tool[];
  response_schema?: unknown;
  context?: ModelRequestContext;
};

export type ModelResponse = {
  content?: string;
  thinking?: string;
  tool_calls?: ModelToolCall[];
};

export type ModelStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "thinking_delta"; text: string };

export type ModelProvider = {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest, onEvent: (event: ModelStreamEvent) => void): Promise<ModelResponse>;
};

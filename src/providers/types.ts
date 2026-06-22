import { Tool } from "../tools/types.js";

export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: "image/png" | "image/jpeg" | "image/webp"; data: string };

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ModelContentPart[];
  tool_call_id?: string;
};

export type ModelToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ModelRequest = {
  model: string;
  messages: ModelMessage[];
  tools: Tool[];
  response_schema?: unknown;
};

export type ModelResponse = {
  content?: string;
  tool_calls?: ModelToolCall[];
};

export type ModelProvider = {
  generate(request: ModelRequest): Promise<ModelResponse>;
};

import { fetch } from "undici";
import { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "./types.js";

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
};

type OpenAiToolCall = {
  id: string;
  function: {
    name: string;
    arguments?: string;
  };
};

export function toOpenAiMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => {
    if (Array.isArray(message.content)) {
      return {
        role: message.role,
        content: message.content.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: `data:${part.media_type};base64,${part.data}` } })
      };
    }
    return { role: message.role, content: message.content, tool_call_id: message.tool_call_id };
  });
}

export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
          }
        }))
      })
    });

    if (!response.ok) {
      throw new Error(`Provider request failed ${response.status}: ${await response.text()}`);
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] } }>;
    };
    const message = body.choices?.[0]?.message ?? {};
    return {
      content: message.content ?? undefined,
      tool_calls: message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || "{}")
      }))
    };
  }
}

import { AgentTeamConfig } from "../config/schema.js";
import { ModelProvider } from "./types.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { ResponsesApiProvider } from "./responsesApi.js";
import { AnthropicMessagesProvider } from "./anthropicMessages.js";

export function createProvider(config: AgentTeamConfig, providerId: string): ModelProvider {
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`Unknown provider ${providerId}`);
  const apiKey = process.env[provider.api_key_env];
  if (!apiKey) throw new Error(`Missing API key environment variable ${provider.api_key_env}`);

  switch (provider.type) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider({
        baseUrl: provider.base_url,
        apiKey,
        apiKeyMode: provider.api_key_mode,
        streaming: provider.capabilities.streaming,
        jsonSchemaOutput: provider.capabilities.json_schema_output,
        userAgent: provider.user_agent
      });
    case "responses-api":
      return new ResponsesApiProvider({
        baseUrl: provider.base_url,
        apiKey,
        apiKeyMode: provider.api_key_mode,
        streaming: provider.capabilities.streaming,
        jsonSchemaOutput: provider.capabilities.json_schema_output,
        userAgent: provider.user_agent,
        promptCache: provider.responses.prompt_cache,
        parallelToolCalls: provider.responses.parallel_tool_calls,
        reasoning: provider.responses.reasoning
      });
    case "anthropic":
      return new AnthropicMessagesProvider({
        baseUrl: provider.base_url,
        apiKey,
        apiKeyMode: provider.api_key_mode,
        streaming: provider.capabilities.streaming,
        jsonSchemaOutput: provider.capabilities.json_schema_output,
        userAgent: provider.user_agent,
        version: provider.anthropic.version,
        betaHeaders: provider.anthropic.beta_headers,
        maxTokens: provider.anthropic.max_tokens,
        promptCache: provider.anthropic.prompt_cache,
        thinking: provider.anthropic.thinking
      });
  }
}

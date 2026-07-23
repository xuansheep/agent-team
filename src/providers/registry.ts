import {
  AgentTeamConfig,
  DEFAULT_REQUEST_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_RETRIES
} from "../config/schema.js";
import { ModelProvider } from "./types.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { ResponsesApiProvider } from "./responsesApi.js";
import { AnthropicMessagesProvider } from "./anthropicMessages.js";

export function createProvider(config: AgentTeamConfig, providerId: string): ModelProvider {
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`Unknown provider ${providerId}`);
  const apiKey = provider.api_key.trim();
  if (!apiKey) throw new Error(`Missing API key for provider ${providerId}; configure api_key in ~/.einsteins/settings.json`);

  switch (provider.type) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider({
        baseUrl: provider.base_url,
        apiKey,
        apiKeyMode: provider.api_key_mode,
        streaming: provider.capabilities.streaming,
        jsonSchemaOutput: provider.capabilities.json_schema_output,
        userAgent: provider.user_agent,
        retry: providerRetryConfig(provider)
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
        reasoning: provider.responses.reasoning,
        retry: providerRetryConfig(provider)
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
        thinking: provider.anthropic.thinking,
        retry: providerRetryConfig(provider)
      });
  }
}

function providerRetryConfig(provider: AgentTeamConfig["providers"][string]) {
  return {
    requestMaxRetries: provider.request_max_retries ?? DEFAULT_REQUEST_MAX_RETRIES,
    streamMaxRetries: provider.stream_max_retries ?? DEFAULT_STREAM_MAX_RETRIES,
    requestTimeoutMs: provider.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: provider.stream_idle_timeout_ms ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  };
}

import { AgentTeamConfig } from "../config/schema.js";
import { ModelProvider } from "./types.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";

export function createProvider(config: AgentTeamConfig, providerId: string): ModelProvider {
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`Unknown provider ${providerId}`);
  const apiKey = process.env[provider.api_key_env];
  if (!apiKey) throw new Error(`Missing API key environment variable ${provider.api_key_env}`);
  return new OpenAiCompatibleProvider({
    baseUrl: provider.base_url,
    apiKey,
    streaming: provider.capabilities.streaming,
    jsonSchemaOutput: provider.capabilities.json_schema_output,
    userAgent: provider.user_agent
  });
}

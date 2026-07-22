import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApiKeyHeaders, providerHttpError } from "../../src/providers/http.js";
import { configSchema, providerSchema } from "../../src/config/schema.js";
import { createProvider } from "../../src/providers/registry.js";

describe("buildApiKeyHeaders", () => {
  it("uses bearer authorization headers", () => {
    assert.deepEqual(buildApiKeyHeaders("test-key", "bearer"), {
      authorization: "Bearer test-key"
    });
  });

  it("uses x-api-key headers", () => {
    assert.deepEqual(buildApiKeyHeaders("test-key", "x-api-key"), {
      "x-api-key": "test-key"
    });
  });
});

describe("providerHttpError", () => {
  it("classifies provider context-window errors for reactive compaction", () => {
    assert.equal(providerHttpError(400, '{"error":{"code":"context_length_exceeded"}}').errorKind, "context_limit");
    assert.equal(providerHttpError(400, "maximum context length exceeded").errorKind, "context_limit");
    assert.equal(providerHttpError(400, "ordinary invalid request").errorKind, "invalid_request");
  });
});

describe("createProvider", () => {
  it("uses api_key from user settings and ignores environment variables", () => {
    const originalEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "environment-key";

    try {
      const provider = createProvider(runtimeConfig("settings-key"), "default");
      assert.equal((provider as unknown as { options: { apiKey: string } }).options.apiKey, "settings-key");
    } finally {
      if (originalEnv === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalEnv;
    }
  });

  it("rejects an empty key only when the provider is created", () => {
    assert.throws(
      () => createProvider(runtimeConfig(""), "default"),
      /configure api_key in ~\/.einsteins\/settings.json/
    );
  });
});

function runtimeConfig(apiKey: string) {
  return {
    ...configSchema.parse({
      roles: { dev: { system_prompt: "Build safely." } },
      workflows: { delivery: { nodes: [{ id: "dev", role: "dev", provider: "default" }] } }
    }),
    providers: {
      default: providerSchema.parse({
        type: "openai-compatible",
        base_url: "https://api.example.test/v1",
        api_key: apiKey,
        default_model: "gpt-test"
      })
    }
  };
}

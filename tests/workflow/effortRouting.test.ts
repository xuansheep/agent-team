import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { configSchema, providerSchema } from "../../src/config/schema.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { testDispatcher } from "../helpers/projectConfig.js";

describe("workflow effort routing", () => {
  it("passes a workflow node effort override into the model request", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "done" } }) };
      }
    };
    const base = configSchema.parse({
      roles: { dev: { system_prompt: "Build safely." } },
      workflows: { delivery: { nodes: [{ id: "dev", role: "dev", provider: "default", effort: "node-custom" }] } },
      teams: {}
    });
    const config = {
      ...base,
      dispatcher: testDispatcher,
      providers: {
        default: providerSchema.parse({
          type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true },
          base_url: "https://api.example.test/v1",
          api_key: "test-key",
          default_model: "gpt-test",
          effort: "provider-custom"
        })
      }
    };
    const engine = new WorkflowEngine({
      providerFactory: () => provider,
      cwd: process.cwd(),
      runRoot: `.tmp/effort-routing-${process.pid}-${Date.now()}`
    });

    const result = await engine.run(config, "delivery", { request: "implement" });

    assert.equal(result.status, "awaiting_bus");
    assert.equal(requests[0]?.effort, "node-custom");
  });
});

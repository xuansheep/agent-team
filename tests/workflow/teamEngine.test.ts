import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { RunStore } from "../../src/storage/runStore.js";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import { ModelProviderError, type ModelProvider, type ModelRequest } from "../../src/providers/types.js";
import { testDispatcher } from "../helpers/projectConfig.js";

describe("WorkflowEngine team mode", () => {
  it("returns every node to the bus and runs only dynamically assigned nodes", async () => {
    const calls: string[] = [];
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        calls.push(request.context?.nodeId ?? "unknown");
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "return to bus" } }) };
      }
    };
    const runRoot = `.tmp/team-engine-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config: AgentTeamConfig = {
      providers: {
        default: {
          type: "openai-compatible",
          base_url: "https://api.example.test/v1",
          api_key: "test-key",
          default_model: "gpt-test",
          capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
        }
      },
      dispatcher: testDispatcher,
      roles: {
        a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } },
        b: { description: "", system_prompt: "B", requires: { tool_calling: false, vision: false } }
      },
      workflows: {},
      teams: {
        delivery: {
          nodes: [
            { id: "a", role: "a", provider: "default", permission_mode: "default" },
            { id: "b", role: "b", provider: "default", permission_mode: "default" }
          ],
          edges: []
        }
      }
    };

    const session = await engine.startInteractive(config, "delivery", { request: "x" }, { executionKind: "team" });
    const firstBoundary = await session.waitForBoundary();

    assert.equal(firstBoundary.status, "awaiting_bus");
    assert.equal(firstBoundary.execution_kind, "team");
    assert.deepEqual(firstBoundary.attempts.map((attempt) => attempt.node_id), ["a"]);
    assert.deepEqual(calls, ["a"]);
    const firstSystemPrompt = requests[0]?.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n") ?? "";
    const firstRuntimeContext = requests[0]?.messages.find((message) => message.role === "user")?.content;
    assert.match(firstSystemPrompt, /dynamically routed team member/);
    assert.match(String(firstRuntimeContext), /"execution_kind": "team"/);
    assert.doesNotMatch(String(firstRuntimeContext), /"navigation":/);

    await session.dispatchToNode("b", { instruction: "continue" }, { reason: "bus selected b" });
    const secondBoundary = await session.waitForBoundary();

    assert.equal(secondBoundary.status, "awaiting_bus");
    assert.deepEqual(secondBoundary.attempts.map((attempt) => attempt.node_id), ["a", "b"]);
    assert.deepEqual(calls, ["a", "b"]);

    await session.finalize("Team task completed.");
    const result = await session.result;
    const metadata = await new RunStore(runRoot).metadata(session.runId);
    const dossier = await engine.dossier(session.runId);

    assert.equal(result.status, "completed");
    assert.equal(metadata.executionKind, "team");
    assert.equal(dossier.execution_kind, "team");
  });

  it("returns node failures to the bus for reassignment", async () => {
    const provider: ModelProvider = {
      async generate() {
        throw new ModelProviderError("simulated member failure", { errorKind: "unknown", retryable: false });
      }
    };
    const runRoot = `.tmp/team-failure-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const config: AgentTeamConfig = {
      providers: {
        default: {
          type: "openai-compatible",
          base_url: "https://api.example.test/v1",
          api_key: "test-key",
          default_model: "gpt-test",
          capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
        }
      },
      dispatcher: testDispatcher,
      roles: {
        a: { description: "", system_prompt: "A", requires: { tool_calling: false, vision: false } }
      },
      workflows: {},
      teams: {
        delivery: {
          nodes: [{ id: "a", role: "a", provider: "default", permission_mode: "default" }],
          edges: []
        }
      }
    };

    const session = await engine.startInteractive(config, "delivery", { request: "x" }, { executionKind: "team" });
    const boundary = await session.waitForBoundary();
    const dossier = await engine.dossier(session.runId);

    assert.equal(boundary.status, "awaiting_bus");
    assert.equal(boundary.attempts[0]?.status, "failure");
    assert.equal(dossier.node_results[0]?.status, "failure");
    assert.match(dossier.node_results[0]?.result.summary ?? "", /simulated member failure/);

    await session.finalize("Failure captured for bus handling.");
    await session.result;
  });
});

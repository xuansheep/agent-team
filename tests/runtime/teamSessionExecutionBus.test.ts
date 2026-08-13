import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { ExecutionCoordinator } from "../../src/runtime/executionCoordinator.js";
import { SessionExecutionBus } from "../../src/runtime/sessionExecutionBus.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { testDispatcher } from "../helpers/projectConfig.js";

describe("team execution bus integration", () => {
  it("automatically selects the next member after each boundary until the bus finalizes", async () => {
    let busCalls = 0;
    const memberCalls: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        const nodeId = request.context?.nodeId;
        if (nodeId !== "bus") {
          memberCalls.push(nodeId ?? "unknown");
          return {
            content: JSON.stringify({
              direction: "forward",
              summary: `${nodeId} completed`,
              handoff: { instruction: "return to bus" }
            })
          };
        }

        busCalls += 1;
        if (busCalls === 1) {
          return {
            content: JSON.stringify({
              type: "dispatch",
              confidence: 1,
              node_id: "a",
              instruction: "Run member a.",
              reason: "Start with a"
            })
          };
        }
        if (busCalls === 2) {
          return {
            content: JSON.stringify({
              type: "dispatch",
              confidence: 1,
              node_id: "b",
              instruction: "Run member b.",
              reason: "Continue with b"
            })
          };
        }
        return {
          content: JSON.stringify({
            type: "finalize",
            confidence: 1,
            summary: {
              summary: "Team completed.",
              outcomes: ["a and b completed"],
              verification: ["Both member results are in the dossier"],
              residual_risks: [],
              artifacts: []
            }
          })
        };
      }
    };
    const runRoot = `.tmp/team-bus-integration-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const config: AgentTeamConfig = {
      providers: {
        default: {
          type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true },
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
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const coordinator = new ExecutionCoordinator(engine);
    const bus = new SessionExecutionBus({
      config,
      workflowId: "delivery",
      executionKind: "team",
      coordinator,
      providerFactory: () => provider,
      cwd: process.cwd(),
      sessionId: "team-integration-session"
    });

    try {
      const initialTurn = await bus.handleUserMessage({ request: "complete the team task" });
      assert.ok(initialTurn.workflow);

      await waitFor(() => bus.state.status === "finalized");
      const finalState = await initialTurn.workflow.result;

      assert.equal(bus.state.execution_kind, "team");
      assert.equal(bus.state.status, "finalized");
      assert.equal(busCalls, 3);
      assert.deepEqual(memberCalls, ["a", "b"]);
      assert.equal(finalState.status, "completed");
      assert.deepEqual(finalState.attempts.map((attempt) => attempt.node_id), ["a", "b"]);
    } finally {
      bus.dispose();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for team bus finalization");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

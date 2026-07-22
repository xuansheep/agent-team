import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runNode, type NodeRuntimeOptions } from "../../src/harness/runtime.js";
import { ModelProviderError, type ModelMessage, type ModelProvider, type ModelRequest } from "../../src/providers/types.js";
import { RunStore } from "../../src/storage/runStore.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const compactSummary = "<summary>Earlier decisions and unfinished work.</summary>";
const nodeResult = JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } });

describe("runNode context compaction", () => {
  it("automatically performs a full compaction before a high-pressure model request", async () => {
    const fixture = await runtimeFixture("agent-team-auto-compact-");
    await fixture.store.appendEvent(fixture.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      context_tokens: 6000,
      context_limit: 4977,
      dialogue_message_count: 1
    });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return request.tools.length === 0
          ? { content: compactSummary, usage: { inputTokens: 6000, outputTokens: 20, totalTokens: 6020 } }
          : { content: nodeResult, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
      }
    };

    const result = await runNode(runtimeOptions(fixture, provider, [{ role: "user", content: "preserve earlier work" }], {
      modelRegistry: { defaultContextWindow: 5000 },
      maxOutputTokens: 10
    }));

    assert.equal(result.direction, "forward");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.tools.length, 0);
    assert.equal(requests[0]?.maxOutputTokens, 10);
    assert.equal(requests[1]?.maxOutputTokens, 10);
    assert.equal(requests[0]?.context?.threadId, requests[1]?.context?.threadId);
    assert.equal(requests[0]?.context?.promptCacheKey, requests[1]?.context?.promptCacheKey);
    const events = await fixture.store.loadEvents(fixture.runId);
    const compacted = events.find((event) => event.type === "node_context_compacted" && event.kind === "full");
    assert.equal(compacted?.type, "node_context_compacted");
    if (compacted?.type === "node_context_compacted") assert.equal(compacted.trigger, "auto");
    const dialogue = await fixture.store.loadWorkflowDialogue(fixture.runId, "dev", 1);
    assert.equal(dialogue.some((message) => message.metadata?.compactSummary === true), true);
  });

  it("reactively compacts once and retries a provider context-limit failure", async () => {
    const fixture = await runtimeFixture("agent-team-reactive-compact-");
    const requests: ModelRequest[] = [];
    let normalRequests = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        if (request.tools.length === 0) return { content: compactSummary };
        normalRequests += 1;
        if (normalRequests === 1) {
          throw new ModelProviderError("maximum context length exceeded", {
            errorKind: "context_limit",
            status: 400
          });
        }
        return { content: nodeResult };
      }
    };

    const result = await runNode(runtimeOptions(fixture, provider, [{ role: "user", content: "continue this work" }]));

    assert.equal(result.direction, "forward");
    assert.equal(normalRequests, 2);
    assert.equal(requests.filter((request) => request.tools.length === 0).length, 1);
    const events = await fixture.store.loadEvents(fixture.runId);
    const compacted = events.find((event) => event.type === "node_context_compacted" && event.kind === "full");
    assert.equal(compacted?.type, "node_context_compacted");
    if (compacted?.type === "node_context_compacted") assert.equal(compacted.trigger, "reactive");
  });

  it("publishes the new automatic limit immediately after a skill changes the model", async () => {
    const fixture = await runtimeFixture("agent-team-skill-model-limit-");
    const tools = new ToolRegistry();
    tools.add({
      name: "SwitchModel",
      description: "switches the model for this node",
      input_schema: {},
      isReadOnly: () => true,
      async execute() {
        return {
          output: "activated",
          data: {
            type: "skill_activation",
            name: "small-context",
            mode: "inline",
            source: "test",
            allowedTools: [],
            model: "small"
          }
        };
      }
    });
    const models: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        models.push(request.model);
        if (models.length === 1) {
          return {
            content: "switching",
            tool_calls: [{ id: "switch-1", name: "SwitchModel", input: {} }]
          };
        }
        return { content: nodeResult };
      }
    };

    const result = await runNode(runtimeOptions(fixture, provider, [], {
      model: "old",
      modelRegistry: { contextWindows: { old: 50000, small: 40000 } },
      maxOutputTokens: 10,
      tools,
      permissions: { allow: ["SwitchModel"], ask: [], deny: [] }
    }));

    assert.equal(result.direction, "forward");
    assert.deepEqual(models, ["old", "small"]);
    const contextEvents = (await fixture.store.loadEvents(fixture.runId)).filter((event) => event.type === "node_context_updated");
    assert.equal(contextEvents.some((event) => event.context_limit === 26990), true);
  });

  it("retries only compaction at the blocking limit and opens the circuit after three failures", async () => {
    const fixture = await runtimeFixture("agent-team-compact-breaker-");
    await fixture.store.appendEvent(fixture.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      context_tokens: 6000,
      context_limit: 4977,
      dialogue_message_count: 1
    });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        throw new Error("summary failed");
      }
    };

    await assert.rejects(
      () => runNode(runtimeOptions(fixture, provider, [{ role: "user", content: "preserve earlier work" }], {
        modelRegistry: { defaultContextWindow: 5000 },
        maxOutputTokens: 10
      })),
      /circuit breaker opened after 3 consecutive failures/
    );

    assert.equal(requests.length, 3);
    assert.equal(requests.every((request) => request.tools.length === 0), true);
    const failures = (await fixture.store.loadEvents(fixture.runId)).filter((event) => event.type === "node_context_compaction_failed");
    assert.deepEqual(failures.map((event) => event.failure_count), [1, 2, 3]);
  });
});

type RuntimeFixture = {
  store: RunStore;
  runId: string;
};

async function runtimeFixture(prefix: string): Promise<RuntimeFixture> {
  const tempRoot = join(process.cwd(), ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, prefix));
  const store = new RunStore(root);
  const run = await store.createRun("flow", { request: "x" });
  return { store, runId: run.runId };
}

function runtimeOptions(
  fixture: RuntimeFixture,
  provider: ModelProvider,
  dialogueMessages: ModelMessage[],
  overrides: Partial<NodeRuntimeOptions> = {}
): NodeRuntimeOptions {
  return {
    node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
    systemPrompt: "Dev",
    model: "gpt-test",
    provider,
    tools: new ToolRegistry(),
    permissions: { allow: [], ask: [], deny: [] },
    cwd: process.cwd(),
    runId: fixture.runId,
    store: fixture.store,
    handoff: { request: "x" },
    attempt: 1,
    activation: 1,
    dialogueMessages,
    ...overrides
  };
}

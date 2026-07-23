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
    const summaryRequest = requests[0]!;
    assert.equal(summaryRequest.messages.filter((message) => message.role === "system").length, 1);
    assert.match(String(summaryRequest.messages.find((message) => message.role === "system")?.content), /Dev/);
    assert.equal(summaryRequest.messages.some((message) => message.content === "preserve earlier work"), true);
    assert.equal(summaryRequest.messages.some((message) => String(message.content).includes("CONTEXT CHECKPOINT COMPACTION")), true);
    assert.equal(summaryRequest.messages.some((message) => message.content === "Dev"), false);
    const normalMessages = requests[1]!.messages;
    const canonicalContextIndex = normalMessages.findIndex((message) => String(message.content).includes('"node_id": "dev"'));
    const retainedUserIndex = normalMessages.findIndex((message) => message.content === "preserve earlier work");
    const summaryIndex = normalMessages.findIndex((message) => message.metadata?.compactSummary === true);
    assert.ok(canonicalContextIndex >= 0 && canonicalContextIndex < retainedUserIndex);
    assert.ok(retainedUserIndex < summaryIndex);
    assert.equal(summaryIndex, normalMessages.length - 1);
    const events = await fixture.store.loadEvents(fixture.runId);
    const compacted = events.find((event) => event.type === "node_context_compacted");
    assert.equal(compacted?.type, "node_context_compacted");
    if (compacted?.type === "node_context_compacted") assert.equal(compacted.trigger, "auto");
    const dialogue = await fixture.store.loadWorkflowDialogue(fixture.runId, "dev", 1);
    const persistedSummary = dialogue.find((message) => message.metadata?.compactSummary === true);
    assert.equal(persistedSummary?.role, "user");
    assert.equal(String(persistedSummary?.content).includes("CONTEXT CHECKPOINT COMPACTION"), false);
  });

  it("streams local compaction, retries context limits, and keeps summary deltas internal", async () => {
    const fixture = await runtimeFixture("agent-team-stream-compact-");
    await fixture.store.appendEvent(fixture.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      context_tokens: 6000,
      context_limit: 4500,
      dialogue_message_count: 3
    });
    const summaryRequests: ModelRequest[] = [];
    let generateCalls = 0;
    const provider: ModelProvider = {
      async generate() {
        generateCalls += 1;
        throw new Error("generate should not be used when stream is available");
      },
      async stream(request, onEvent) {
        if (request.tools.length === 0) {
          summaryRequests.push(request);
          onEvent({ type: "content_delta", text: "internal-summary-fragment" });
          if (summaryRequests.length === 1) {
            throw new ModelProviderError("summary input too large", { errorKind: "context_limit" });
          }
          onEvent({ type: "content_delta", text: compactSummary });
          return { content: compactSummary, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
        }
        onEvent({ type: "content_delta", text: nodeResult });
        return { content: nodeResult, usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } };
      }
    };
    const dialogue: ModelMessage[] = [
      { role: "assistant", content: "old call", tool_calls: [{ id: "read-1", name: "Read", input: {} }] },
      { role: "tool", tool_call_id: "read-1", content: "old result" },
      { role: "user", content: "latest request", metadata: { userMessageKind: "human" } }
    ];

    const result = await runNode(runtimeOptions(fixture, provider, dialogue, {
      modelRegistry: { defaultContextWindow: 5000 }
    }));

    assert.equal(result.direction, "forward");
    assert.equal(generateCalls, 0);
    assert.equal(summaryRequests.length, 2);
    assert.equal(summaryRequests[0]!.messages.some((message) => message.content === "old result"), true);
    assert.equal(summaryRequests[1]!.messages.some((message) => message.content === "old result"), false);
    const deltas = (await fixture.store.loadEvents(fixture.runId)).filter((event) => event.type === "model_stream_delta");
    assert.equal(deltas.some((event) => event.text.includes("internal-summary-fragment") || event.text.includes("Earlier decisions")), false);
    assert.equal(deltas.map((event) => event.text).join(""), nodeResult);
  });

  it("ends the activation on a provider context-limit failure without reactive compaction", async () => {
    const fixture = await runtimeFixture("agent-team-reactive-compact-");
    const requests: ModelRequest[] = [];
    let normalRequests = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        if (request.tools.length === 0) return { content: compactSummary };
        normalRequests += 1;
        throw new ModelProviderError("maximum context length exceeded", {
          errorKind: "context_limit",
          status: 400
        });
      }
    };

    await assert.rejects(
      () => runNode(runtimeOptions(fixture, provider, [{ role: "user", content: "continue this work" }])),
      /maximum context length exceeded/
    );

    assert.equal(normalRequests, 1);
    assert.equal(requests.filter((request) => request.tools.length === 0).length, 0);
    const events = await fixture.store.loadEvents(fixture.runId);
    assert.equal(events.some((event) => event.type === "node_context_compacted"), false);
    const context = events.filter((event) => event.type === "node_context_updated").at(-1);
    assert.ok((context?.type === "node_context_updated" ? context.context_tokens : 0) >= 258400);
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
    assert.equal(contextEvents.some((event) => event.context_limit === 36000 && event.context_window === 38000), true);
  });

  it("uses the previous model for pre-turn compaction when compaction hashes differ", async () => {
    const fixture = await runtimeFixture("agent-team-model-change-compact-");
    await fixture.store.appendEvent(fixture.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      model: "old",
      compaction_hash: "hash-old",
      context_window: 100000,
      context_tokens: 100,
      context_limit: 90000,
      window_number: 0,
      current_window_id: "window-old",
      dialogue_message_count: 1
    });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return request.tools.length === 0 ? { content: compactSummary } : { content: nodeResult };
      }
    };

    await runNode(runtimeOptions(fixture, provider, [
      { role: "user", content: "existing work", metadata: { userMessageKind: "human" } }
    ], {
      model: "new",
      modelRegistry: {
        contextWindows: { old: 100000, new: 100000 },
        compactionHashes: { old: "hash-old", new: "hash-new" }
      }
    }));

    assert.deepEqual(requests.map((request) => request.model), ["old", "new"]);
    const event = (await fixture.store.loadEvents(fixture.runId))
      .find((item) => item.type === "node_context_compacted");
    assert.equal(event?.type === "node_context_compacted" ? event.reason : undefined, "model_change");
  });

  it("supports body-after-prefix threshold scope while retaining the full-window hard limit", async () => {
    const fixture = await runtimeFixture("agent-team-body-after-prefix-");
    await fixture.store.appendEvent(fixture.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      model: "gpt-test",
      context_window: 10000,
      context_tokens: 9200,
      context_limit: 9000,
      prefix_input_tokens: 1000,
      window_number: 0,
      current_window_id: "window-1",
      dialogue_message_count: 1
    });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: nodeResult };
      }
    };

    await runNode(runtimeOptions(fixture, provider, [{ role: "user", content: "continue" }], {
      modelRegistry: {
        defaultContextWindow: 10000,
        autoCompactTokenLimitScope: "body_after_prefix"
      }
    }));

    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.tools.length > 0);
  });

  it("drops one oldest paired tool exchange per compaction context-limit retry", async () => {
    const fixture = await runtimeFixture("agent-team-compact-drop-oldest-");
    await fixture.store.appendEvent(fixture.runId, {
      type: "node_context_updated",
      node_id: "dev",
      attempt: 1,
      activation: 1,
      context_tokens: 6000,
      context_limit: 4500,
      dialogue_message_count: 3
    });
    const summaryRequests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        if (request.tools.length !== 0) return { content: nodeResult };
        summaryRequests.push(request);
        if (summaryRequests.length === 1) {
          throw new ModelProviderError("summary input too large", { errorKind: "context_limit" });
        }
        return { content: compactSummary };
      }
    };
    const dialogue: ModelMessage[] = [
      { role: "assistant", content: "old call", tool_calls: [{ id: "read-1", name: "Read", input: {} }] },
      { role: "tool", tool_call_id: "read-1", content: "old result" },
      { role: "user", content: "latest request", metadata: { userMessageKind: "human" } }
    ];

    await runNode(runtimeOptions(fixture, provider, dialogue, {
      modelRegistry: { defaultContextWindow: 5000 }
    }));

    assert.equal(summaryRequests.length, 2);
    assert.equal(summaryRequests[0]!.messages.some((message) => message.content === "old result"), true);
    assert.equal(summaryRequests[1]!.messages.some((message) => message.content === "old result"), false);
    assert.equal(summaryRequests[1]!.messages.some((message) => message.content === "latest request"), true);
  });

  it("ends the activation after one local compaction failure", async () => {
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
      /summary failed/
    );

    assert.equal(requests.length, 1);
    assert.equal(requests.every((request) => request.tools.length === 0), true);
    const failures = (await fixture.store.loadEvents(fixture.runId)).filter((event) => event.type === "node_context_compaction_failed");
    assert.equal(failures.length, 1);
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

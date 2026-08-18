import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runNode, type NodeRuntimeOptions } from "../../src/harness/runtime.js";
import { ModelProviderError, type ModelMessage, type ModelProvider, type ModelRequest } from "../../src/providers/types.js";
import { RunStore } from "../../src/storage/runStore.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const nodeResult = JSON.stringify({
  direction: "forward",
  summary: "done",
  handoff: { instruction: "complete" }
});

describe("runNode provider continuation", () => {
  it("sends a full first request and only incremental messages after a durable assistant response", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-incremental-");
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: "Reading.",
            tool_calls: [{ id: "read-1", name: "ReadOnce", input: {} }],
            providerResponseId: "resp-1"
          };
        }
        return { content: nodeResult, providerResponseId: "resp-2" };
      }
    };
    const tools = new ToolRegistry();
    tools.add({
      name: "ReadOnce",
      description: "read once",
      input_schema: {},
      isReadOnly: () => true,
      async execute() {
        return { output: "tool result" };
      }
    });

    const result = await runNode(runtimeOptions(fixture, provider, tools));

    assert.equal(result.direction, "forward");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.continuation, undefined);
    assert.equal(requests[1]!.continuation?.previousResponseId, "resp-1");
    assert.deepEqual(
      requests[1]!.continuation?.inputMessages.map((message) => message.role),
      ["tool"]
    );
    assert.match(String(requests[0]!.context?.turnId), /^[0-9a-f-]{36}$/);
    assert.match(String(requests[1]!.context?.turnId), /^[0-9a-f-]{36}$/);
    assert.notEqual(requests[0]!.context?.turnId, requests[1]!.context?.turnId);

    const events = await fixture.store.loadEvents(fixture.runId);
    const recorded = events.filter((event) => event.type === "model_response_recorded");
    const continued = recorded.at(-1);
    assert.equal(continued?.type === "model_response_recorded" ? continued.diagnostics?.continuation : undefined, true);
    assert.equal(continued?.type === "model_response_recorded" ? continued.diagnostics?.continuation_attempted : undefined, true);
    assert.equal(continued?.type === "model_response_recorded" ? continued.diagnostics?.continuation_outcome : undefined, "succeeded");
    assert.equal(continued?.type === "model_response_recorded" ? continued.diagnostics?.continuation_input_message_count : undefined, 1);
    assert.equal(continued?.type === "model_response_recorded" ? continued.diagnostics?.checkpoint_state : undefined, "usable");
    assert.equal(continued?.type === "model_response_recorded" ? continued.diagnostics?.provider_response_id_present : undefined, true);
    assert.equal(typeof (continued?.type === "model_response_recorded" ? continued.diagnostics?.provider_response_id_hash : undefined), "string");
    assert.equal(typeof (continued?.type === "model_response_recorded" ? continued.diagnostics?.continuation_response_id_hash : undefined), "string");
    assert.equal(JSON.stringify(events).includes("resp-1"), false);
    assert.equal(JSON.stringify(events).includes("resp-2"), false);
  });

  it("rebuilds once with full input when a continuation request fails", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-rebuild-");
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            content: "Reading.",
            tool_calls: [{ id: "read-rebuild-1", name: "ReadOnce", input: {} }],
            providerResponseId: "resp-rebuild-1"
          };
        }
        if (request.continuation) {
          throw new ModelProviderError(
            "stale previous response " + request.continuation.previousResponseId,
            {
              errorKind: "invalid_request",
              status: 400,
              phase: "request",
              retryable: false,
              detail: "provider rejected " + request.continuation.previousResponseId
            }
          );
        }
        return { content: nodeResult, providerResponseId: "resp-rebuild-2" };
      }
    };
    const tools = new ToolRegistry();
    tools.add({
      name: "ReadOnce",
      description: "read once",
      input_schema: {},
      isReadOnly: () => true,
      async execute() {
        return { output: "tool result" };
      }
    });

    const result = await runNode(runtimeOptions(fixture, provider, tools));

    assert.equal(result.direction, "forward");
    assert.equal(requests.length, 3);
    assert.equal(requests[1]!.continuation?.previousResponseId, "resp-rebuild-1");
    assert.equal(requests[2]!.continuation, undefined);
    assert.equal(requests[2]!.messages.some((message) => message.role === "assistant"), true);
    assert.equal(requests[2]!.messages.some((message) => message.role === "tool"), true);
    assert.match(String(requests[2]!.context?.turnId), /:rebuild$/);
    assert.notEqual(requests[1]!.context?.turnId, requests[2]!.context?.turnId);

    const events = await fixture.store.loadEvents(fixture.runId);
    const fallbacks = events.filter((event) => event.type === "provider_continuation_fallback");
    assert.equal(fallbacks.length, 1);
    const fallback = fallbacks[0];
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.continuation_turn_id : undefined, requests[1]!.context?.turnId);
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.rebuild_turn_id : undefined, requests[2]!.context?.turnId);
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.continuation_input_message_count : undefined, 1);
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.error_kind : undefined, "invalid_request");
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.status : undefined, 400);
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.phase : undefined, "request");
    assert.equal(fallback?.type === "provider_continuation_fallback" ? fallback.retryable : undefined, false);
    assert.match(fallback?.type === "provider_continuation_fallback" ? fallback.error : "", /provider_response_id:/);
    assert.match(fallback?.type === "provider_continuation_fallback" ? fallback.detail ?? "" : "", /provider_response_id:/);

    const recorded = events.filter((event) => event.type === "model_response_recorded").at(-1);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.continuation : undefined, false);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.continuation_attempted : undefined, true);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.continuation_outcome : undefined, "fallback_rebuild");
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.checkpoint_state : undefined, "usable");
    assert.equal(JSON.stringify(events).includes("resp-rebuild-1"), false);
    assert.equal(JSON.stringify(events).includes("resp-rebuild-2"), false);
  });

  it("does not rebuild a failed request without continuation", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-no-rebuild-");
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        throw new Error("first request failed");
      }
    };

    await assert.rejects(
      () => runNode(runtimeOptions(fixture, provider, new ToolRegistry())),
      /first request failed/
    );
    assert.equal(calls, 1);
    const events = await fixture.store.loadEvents(fixture.runId);
    assert.equal(events.some((event) => event.type === "provider_continuation_fallback"), false);
  });

  it("restores a continuation checkpoint through a fresh RunStore", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-recovery-");
    const waitingRequests: ModelRequest[] = [];
    const waitingProvider: ModelProvider = {
      async generate(request) {
        waitingRequests.push(request);
        return {
          content: "I need input.",
          tool_calls: [{ id: "ask-1", name: "Ask", input: {} }],
          providerResponseId: "resp-before-restart"
        };
      }
    };
    const tools = userInputTools();

    const waiting = await runNode(runtimeOptions(fixture, waitingProvider, tools));
    assert.equal((waiting as unknown as { status: string }).status, "waiting_user");

    const recoveredStore = new RunStore(fixture.root);
    const dialogue = await recoveredStore.loadWorkflowDialogue(fixture.runId, "dev", 1);
    const resumedRequests: ModelRequest[] = [];
    const resumedProvider: ModelProvider = {
      async generate(request) {
        resumedRequests.push(request);
        return { content: nodeResult, providerResponseId: "resp-after-restart" };
      }
    };
    const result = await runNode(runtimeOptions(
      { ...fixture, store: recoveredStore },
      resumedProvider,
      tools,
      { dialogueMessages: dialogue }
    ));

    assert.equal(result.direction, "forward");
    assert.equal(resumedRequests[0]!.continuation?.previousResponseId, "resp-before-restart");
    assert.deepEqual(
      resumedRequests[0]!.continuation?.inputMessages.map((message) => message.role),
      ["tool"]
    );
    const recorded = (await recoveredStore.loadEvents(fixture.runId))
      .filter((event) => event.type === "model_response_recorded")
      .at(-1);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.checkpoint_state : undefined, "usable");
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.continuation_outcome : undefined, "succeeded");
  });

  it("breaks the chain when the system fingerprint changes", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-fingerprint-");
    const tools = userInputTools();
    const waitingProvider: ModelProvider = {
      async generate() {
        return {
          content: "I need input.",
          tool_calls: [{ id: "ask-1", name: "Ask", input: {} }],
          providerResponseId: "resp-old-system"
        };
      }
    };
    await runNode(runtimeOptions(fixture, waitingProvider, tools));

    const recoveredStore = new RunStore(fixture.root);
    const dialogue = await recoveredStore.loadWorkflowDialogue(fixture.runId, "dev", 1);
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: nodeResult };
      }
    };
    await runNode(runtimeOptions(
      { ...fixture, store: recoveredStore },
      provider,
      tools,
      { systemPrompt: "Changed system", dialogueMessages: dialogue }
    ));

    assert.equal(requests[0]!.continuation, undefined);
    assert.equal(await recoveredStore.loadProviderContinuationCheckpoint(fixture.runId, "dev", 1), undefined);
    const recorded = (await recoveredStore.loadEvents(fixture.runId))
      .filter((event) => event.type === "model_response_recorded")
      .at(-1);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.checkpoint_state : undefined, "rejected");
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.checkpoint_rejection_reason : undefined, "system");
  });

  it("breaks the chain when continuation request properties change", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-request-properties-");
    const tools = userInputTools();
    const waitingProvider: ModelProvider = {
      async generate() {
        return {
          content: "I need input.",
          tool_calls: [{ id: "ask-properties", name: "Ask", input: {} }],
          providerResponseId: "resp-old-properties"
        };
      }
    };
    await runNode(runtimeOptions(fixture, waitingProvider, tools));

    const recoveredStore = new RunStore(fixture.root);
    const dialogue = await recoveredStore.loadWorkflowDialogue(fixture.runId, "dev", 1);
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: nodeResult };
      }
    };
    await runNode(runtimeOptions(
      { ...fixture, store: recoveredStore },
      provider,
      tools,
      { effort: "high", dialogueMessages: dialogue }
    ));

    assert.equal(requests[0]!.continuation, undefined);
    const recorded = (await recoveredStore.loadEvents(fixture.runId))
      .filter((event) => event.type === "model_response_recorded")
      .at(-1);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.checkpoint_state : undefined, "rejected");
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.checkpoint_rejection_reason : undefined, "request_properties");
  });

  it("records when the provider does not return a response id", async () => {
    const fixture = await runtimeFixture("agent-team-continuation-no-response-id-");
    const provider: ModelProvider = {
      async generate() {
        return { content: nodeResult };
      }
    };

    const result = await runNode(runtimeOptions(fixture, provider, new ToolRegistry()));

    assert.equal(result.direction, "forward");
    const recorded = (await fixture.store.loadEvents(fixture.runId))
      .filter((event) => event.type === "model_response_recorded")
      .at(-1);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.provider_response_id_present : undefined, false);
    assert.equal(recorded?.type === "model_response_recorded" ? recorded.diagnostics?.provider_response_id_hash : undefined, undefined);
  });
});

type RuntimeFixture = {
  root: string;
  store: RunStore;
  runId: string;
};

async function runtimeFixture(prefix: string): Promise<RuntimeFixture> {
  const tempRoot = join(process.cwd(), ".tmp");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, prefix));
  const store = new RunStore(root);
  const run = await store.createRun("flow", { request: "x" });
  return { root, store, runId: run.runId };
}

function userInputTools(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.add({
    name: "Ask",
    description: "request user input",
    input_schema: {},
    isReadOnly: () => true,
    async execute() {
      return {
        data: {
          type: "user_input_requested",
          questions: [{ id: "answer", question: "Continue?" }]
        }
      };
    }
  });
  return tools;
}

function runtimeOptions(
  fixture: RuntimeFixture,
  provider: ModelProvider,
  tools: ToolRegistry,
  overrides: Partial<NodeRuntimeOptions> = {}
): NodeRuntimeOptions {
  let dialogue = [...overrides.dialogueMessages ?? []] as ModelMessage[];
  return {
    node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
    systemPrompt: "Dev",
    model: "gpt-test",
    provider,
    tools,
    permissions: { allow: tools.list().map((tool) => tool.name), ask: [], deny: [] },
    cwd: process.cwd(),
    runId: fixture.runId,
    store: fixture.store,
    handoff: { request: "x" },
    attempt: 1,
    activation: 1,
    ...overrides,
    onDialogueMessage: async (message) => {
      dialogue = [...dialogue, message];
      return fixture.store.syncWorkflowDialogue(fixture.runId, "dev", 1, dialogue, 1);
    }
  };
}

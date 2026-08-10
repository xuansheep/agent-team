import { describe, it } from "node:test";

import assert from "node:assert/strict";

import { WorkflowEngine } from "../../src/workflow/engine.js";
import { CONVERSATION_INTERRUPTED_QUESTION_ID, CONVERSATION_INTERRUPTED_TEXT } from "../../src/workflow/state.js";
import { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { RunStore } from "../../src/storage/runStore.js";
import { testDispatcher } from "../helpers/projectConfig.js";

describe("WorkflowSession", () => {

  it("streams events and resolves a completed result", async () => {

    const provider: ModelProvider = {

      async generate() {

        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };

      }

    };

    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-runs" });

    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    const seen: string[] = [];

    for await (const event of session.events) {

      seen.push(event.type);

      if (event.type === "node_completed") break;

    }

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    await session.finalize("test summary");
    const result = await session.result;

    assert.equal(result.status, "completed");

    assert.equal(seen.includes("node_started"), true);

    assert.equal(seen.includes("node_completed"), true);

  });

  it("marks a running session waiting for user input when interrupted", async () => {
    let release!: () => void;

    const provider: ModelProvider = {

      async generate() {

        await new Promise<void>((resolve) => {

          release = resolve;

        });

        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };

      }

    };

    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-interrupt-runs" });

    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    for await (const event of session.events) {

      if (event.type === "node_started") break;

    }

    await waitUntil(() => typeof release === "function");
    const interruption = session.interrupt();
    release();
    await interruption;

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "paused");

    const store = new RunStore(".tmp/session-interrupt-runs");
    const state = await store.loadState(session.runId);
    assert.equal(state.status, "paused");
    assert.equal(state.attempts.at(-1)?.status, "waiting_user");
    assert.deepEqual(state.pending_interaction, {
      type: "node_user",
      node_id: "dev",
      questions: [{ id: CONVERSATION_INTERRUPTED_QUESTION_ID, text: CONVERSATION_INTERRUPTED_TEXT, required: true }]
    });
  });

  it("aborts the active provider and emits one pause event", async () => {
    let providerStarted = false;
    let providerAborted = false;
    const runRoot = `.tmp/session-provider-abort-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        providerStarted = true;
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            providerAborted = true;
            reject(request.signal?.reason);
          };
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
        throw new Error("Provider continued after abort");
      }
    };
    const session = await new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot })
      .startInteractive(config(), "flow", { request: "x" });
    await waitUntil(() => providerStarted);
    await session.interrupt();
    const store = new RunStore(runRoot);
    const events = await store.loadEvents(session.runId);
    const state = await store.loadState(session.runId);
    assert.equal(providerAborted, true);
    assert.equal(state.status, "paused");
    const waitingEvent = events.find((event) => event.type === "node_waiting_user");
    assert.deepEqual(waitingEvent?.questions, [{ id: CONVERSATION_INTERRUPTED_QUESTION_ID, text: CONVERSATION_INTERRUPTED_TEXT, required: true }]);
    assert.equal(events.filter((event) => event.type === "node_waiting_user").length, 1);
    assert.equal(events.some((event) => event.type === "node_completed" && event.status === "failure"), false);
  });
  it("queues immediate user input while interruption is converging", async () => {
    let calls = 0;
    let providerStarted = false;
    const runRoot = `.tmp/session-immediate-resume-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls > 1) {
          return { content: JSON.stringify({ direction: "forward", summary: "resumed", handoff: { instruction: "done" } }) };
        }
        providerStarted = true;
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(request.signal?.reason);
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
        throw new Error("Provider continued after abort");
      }
    };
    const session = await new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot })
      .startInteractive(config(), "flow", { request: "x" });
    await waitUntil(() => providerStarted);
    const interruption = session.interrupt();
    const resumption = session.resumeWithUserInput({ answer: "continue now" });
    await Promise.all([interruption, resumption]);
    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    await session.finalize("test summary");
    const result = await session.result;
    const events = await new RunStore(runRoot).loadEvents(session.runId);
    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(events.filter((event) => event.type === "node_waiting_user").length, 1);
    assert.deepEqual(events.filter((event) => event.type === "user_message").map((event) => event.text), ["continue now"]);
  });
  it("continues an interrupted session from the checkpoint node", async () => {
    let calls = 0;
    let release!: () => void;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ direction: "forward", summary: "planned", handoff: { instruction: "build" } }) };
        }
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { content: JSON.stringify({ direction: "forward", summary: "ignored after interrupt", handoff: { instruction: "old" } }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "resumed dev", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/session-checkpoint-interrupt-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(twoNodeConfig(), "flow", { request: "x" });
    const iterator = session.events[Symbol.asyncIterator]();

    for (;;) {
      const event = await nextEventWithTimeout(iterator);
      if (event.type === "node_started" && event.node_id === "dev") break;
    }

    await waitUntil(() => typeof release === "function");
    const interruption = session.interrupt();
    release();
    await interruption;
    const interruptedBoundary = await session.waitForBoundary();
    assert.equal(interruptedBoundary.status, "paused");
    const interruptedState = await new RunStore(runRoot).loadState(session.runId);
    assert.equal(interruptedState.status, "paused");

    await session.resumeWithUserInput({ answer: "resume from here" });
    const resumedBoundary = await session.waitForBoundary();
    assert.equal(resumedBoundary.status, "awaiting_bus");
    await session.finalize("test summary");

    const store = new RunStore(runRoot);
    const events = await store.loadEvents(session.runId);
    const starts = events.filter((event) => event.type === "node_started").map((event) => `${event.node_id}:${event.attempt}`);
    const userMessages = events.filter((event) => event.type === "user_message");
    const state = await store.loadState(session.runId);

    assert.deepEqual(starts, ["product:1", "dev:1", "dev:1"]);
    assert.equal(events.filter((event) => event.type === "run_started").length, 1);
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]?.node_id, "dev");
    assert.equal(userMessages[0]?.attempt, 1);
    assert.equal(state.status, "completed");
    assert.equal(state.current_node_id, "dev");
    assert.equal(state.resume_checkpoint?.node_id, "dev");
    assert.equal(state.resume_checkpoint?.attempt, 1);
    assert.equal(state.resume_checkpoint?.activation, 2);
    assert.ok((state.resume_checkpoint?.dialogue_cursor ?? 0) > 0);
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "product").length, 1);
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 3);
  });

  it("streams permission requests from runtime events so TUI can resolve them", async () => {

    const provider: ModelProvider = {

      async generate() {

        return { tool_calls: [{ id: "tool-1", name: "LS", input: { path: "." } }] };

      }

    };

    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-permission-stream-runs" });

    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    const iterator = session.events[Symbol.asyncIterator]();

    let requestId = "";

    for (;;) {

      const event = await nextEventWithTimeout(iterator);

      if (event.type === "permission_requested") {

        requestId = event.request_id;

        break;

      }

    }

    assert.equal(session.permissions.hasPending(requestId), true);

    await session.interrupt();

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "paused");

  });

  it("marks provider errors as a failed node waiting for user input", async () => {

    const cause = Object.assign(new Error("connect reset"), { code: "ECONNRESET" });

    const provider: ModelProvider = {

      async generate() {

        throw new Error("Provider network request failed after 3 attempts: fetch failed", { cause });

      }

    };

    const runRoot = `.tmp/session-failure-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    const seen: string[] = [];
    for await (const event of session.events) {
      seen.push(event.type);
      if (event.type === "node_waiting_user") break;
    }

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "paused");
    const store = new RunStore(runRoot);
    const state = await store.loadState(session.runId);
    const events = await store.loadEvents(session.runId);

    assert.equal(state.status, "paused");
    assert.equal(state.current_node_id, "dev");
    assert.equal(state.attempts.at(-1)?.status, "failure");
    assert.equal(events.some((event) => event.type === "node_completed" && event.status === "failure"), true);
    assert.equal(events.some((event) => event.type === "node_waiting_user"), true);
    assert.equal(events.some((event) => event.type === "run_failed"), false);
    assert.equal(seen.includes("node_waiting_user"), true);

  });

  it("resumes an interactive session after user input is requested", async () => {

    let calls = 0;
    const requests: unknown[] = [];

    const provider: ModelProvider = {

      async generate(request) {
        requests.push(request);

        calls += 1;

        if (calls === 1) {

          return { content: JSON.stringify({ direction: "backward", summary: "need detail", questions: [{ id: "q1", text: "Target?", required: true }] }) };

        }

        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };

      }

    };

    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-resume-runs" });

    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    const iterator = session.events[Symbol.asyncIterator]();

    for (;;) {

      const next = await iterator.next();

      if (next.done || next.value.type === "node_waiting_user") break;

    }

    await session.resumeWithUserInput({ answer: "operators" });

    const seen: string[] = [];

    for (;;) {

      const next = await iterator.next();

      if (next.done) break;

      seen.push(next.value.type);

      if (next.value.type === "node_completed") break;

    }

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    await session.finalize("test summary");
    const result = await session.result;

    assert.equal(result.status, "completed");

    assert.equal(result.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(seen.includes("node_started"), true);
    assert.equal(result.attempts.find((attempt) => attempt.node_id === "dev")?.activation, 2);
    const resumedMessages = JSON.stringify((requests[1] as { messages?: unknown[] }).messages);
    assert.match(resumedMessages, /need detail/);
    assert.match(resumedMessages, /operators/);

    assert.equal(seen.includes("user_message"), true);

  });

  it("waits immediately after AskUserQuestion and resumes with the answer", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const runRoot = `.tmp/session-ask-user-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return {
            content: "我需要先确认一个选择。",
            tool_calls: [{
              id: "ask-1",
              name: "AskUserQuestion",
              input: {
                questions: [{
                  header: "方案",
                  question: "选择哪套方案？",
                  options: [
                    { label: "默认方案", description: "使用默认配置。" },
                    { label: "自定义方案", description: "手动指定配置。" }
                  ]
                }]
              }
            }]
          };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const workflowConfig = {
      providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: true, vision: false, streaming: false, json_schema_output: true } } },
    dispatcher: testDispatcher,
    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: true, vision: false } } },
      workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const, permissions: { allow: ["AskUserQuestion"], ask: [], deny: [] } }], edges: [] } }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(workflowConfig, "flow", { request: "x" });
    const iterator = session.events[Symbol.asyncIterator]();
    let waitingEvent;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "node_waiting_user") {
        waitingEvent = next.value;
        break;
      }
    }

    assert.deepEqual(waitingEvent?.questions, [{
      question: "选择哪套方案？",
      header: "方案",
      multiSelect: false,
      options: [
        { label: "默认方案", description: "使用默认配置。", value: "默认方案" },
        { label: "自定义方案", description: "手动指定配置。", value: "自定义方案" }
      ],
      id: "方案",
      text: "选择哪套方案？",
      required: true,
      allow_freeform: true
    }]);
    const waitingState = await new RunStore(runRoot).loadState(session.runId);
    assert.equal(waitingState.status, "waiting_user");
    assert.equal(waitingState.pending_interaction?.type, "node_user");
    assert.equal(waitingState.attempts.at(-1)?.status, "waiting_user");

    await session.resumeWithUserInput({ answer: "默认方案" });
    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    await session.finalize("test summary");
    const result = await session.result;
    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.match(JSON.stringify(requests[1]?.messages), /默认方案/);

    const events = await new RunStore(runRoot).loadEvents(session.runId);
    assert.equal(events.filter((event) => event.type === "node_waiting_user").length, 1);
    assert.equal(events.some((event) => event.type === "user_input_deferred"), false);
    assert.equal(events.some((event) => event.type === "node_waiting_user" && event.questions.some((question) => (question as { id?: string }).id === CONVERSATION_INTERRUPTED_QUESTION_ID)), false);
  });

  it("replays a completed run without invoking the provider again", async () => {

    let calls = 0;

    const provider: ModelProvider = {

      async generate() {

        calls += 1;

        return { content: JSON.stringify({ direction: "forward", summary: "done", handoff: { instruction: "next" } }) };

      }

    };

    const runRoot = ".tmp/session-resume-completed-runs";

    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });

    const original = await engine.startInteractive(config(), "flow", { request: "x" });

    const boundary = await original.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    await original.finalize("test summary");
    const completed = await original.result;

    assert.equal(completed.status, "completed");

    assert.equal(calls, 1);

    const replayEngine = new WorkflowEngine({

      providerFactory: () => ({

        async generate() {

          throw new Error("provider should not be called for completed resume");

        }

      }),

      cwd: process.cwd(),

      runRoot

    });

    const changedConfig = config();
    changedConfig.roles.dev = { ...changedConfig.roles.dev, system_prompt: "current role prompt" };
    const resumed = await replayEngine.resumeInteractive(changedConfig, original.runId);

    const events: string[] = [];

    for await (const event of resumed.events) events.push(event.type);

    assert.equal((await resumed.result).status, "completed");

    assert.deepEqual(events.filter((event) => event === "run_started"), ["run_started"]);

  });

  it("continues a restored completed run from the final node checkpoint", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const runRoot = `.tmp/session-continue-completed-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) return { content: "not a node result" };
        return {
          content: JSON.stringify({
            direction: "forward",
            summary: calls === 2 ? "initial delivery" : "follow-up delivery",
            handoff: { instruction: "done" }
          })
        };
      }
    };
    const teamConfig = config();
    const original = await new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot })
      .startInteractive(teamConfig, "flow", { request: "initial request" });
    const firstBoundary = await original.waitForBoundary();
    assert.equal(firstBoundary.status, "awaiting_bus");
    await original.finalize("initial test summary");
    const firstCompletion = await original.result;
    const firstCursor = firstCompletion.resume_checkpoint?.dialogue_cursor ?? 0;

    assert.equal(firstCompletion.status, "completed");
    assert.equal(firstCompletion.current_node_id, "dev");
    assert.ok(firstCursor > 1);

    const restored = await new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot })
      .resumeInteractive(teamConfig, original.runId);
    await restored.result;
    for await (const _event of restored.events) {
      // Drain replayed events before subscribing to the continuation.
    }
    const continuation = restored.continueWithInput({ request: "follow-up request" });
    const firstContinuationEvent = await restored.events[Symbol.asyncIterator]().next();
    await continuation;
    const continuationBoundary = await restored.waitForBoundary();
    assert.equal(continuationBoundary.status, "awaiting_bus");

    const store = new RunStore(runRoot);
    const state = await store.loadState(original.runId);
    const events = await store.loadEvents(original.runId);
    const devAttempt = state.attempts.find((attempt) => attempt.node_id === "dev");

    assert.equal(restored.runId, original.runId);
    assert.equal(firstContinuationEvent.done, false);
    assert.equal(firstContinuationEvent.value?.type, "run_continued");
    assert.equal(state.status, "awaiting_bus");
    assert.equal(state.current_node_id, "dev");
    assert.equal(devAttempt?.attempt, 1);
    assert.equal(devAttempt?.activation, 2);
    assert.ok((state.resume_checkpoint?.dialogue_cursor ?? 0) > firstCursor);
    assert.match(JSON.stringify(requests.at(-1)?.messages), /follow-up request/);
    assert.equal(events.filter((event) => event.type === "run_started").length, 1);
    assert.equal(events.filter((event) => event.type === "run_continued").length, 1);
    assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
    assert.deepEqual(events.filter((event) => event.type === "user_message").map((event) => event.text), ["follow-up request"]);
    assert.equal(events.some((event) => event.type === "node_completed" && event.status === "failure"), false);

    const secondResult = restored.result;
    await restored.finalize("follow-up test summary");
    const secondCompletion = await secondResult;
    const completedEvents = await store.loadEvents(original.runId);

    assert.equal(secondCompletion.status, "completed");
    assert.equal(secondCompletion.final_summary, "follow-up test summary");
    assert.equal(completedEvents.filter((event) => event.type === "run_started").length, 1);
    assert.equal(completedEvents.filter((event) => event.type === "run_continued").length, 1);
    assert.equal(completedEvents.filter((event) => event.type === "run_completed").length, 2);
  });

  it("lets a reactivated completed node route backward and return in the same run", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const runRoot = `.tmp/session-route-completed-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) return { content: JSON.stringify({ direction: "forward", summary: "planned", handoff: { instruction: "build" } }) };
        if (calls === 2) return { content: JSON.stringify({ direction: "forward", summary: "initial delivery", handoff: { instruction: "done" } }) };
        if (calls === 3) {
          return {
            content: JSON.stringify({
              direction: "backward",
              summary: "follow-up requires upstream work",
              feedback: { defects: [], change_requests: ["apply the follow-up"] },
              handoff: { instruction: "apply the follow-up" }
            })
          };
        }
        if (calls === 4) return { content: JSON.stringify({ direction: "forward", summary: "follow-up applied", handoff: { instruction: "verify" } }) };
        return { content: JSON.stringify({ direction: "forward", summary: "follow-up verified", handoff: { instruction: "done" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(twoNodeConfig(), "flow", { request: "initial request" });
    const initialBoundary = await session.waitForBoundary();
    assert.equal(initialBoundary.status, "awaiting_bus");
    await session.finalize("initial test summary");
    await session.result;
    for await (const _event of session.events) {
      // Drain the first completed segment before subscribing to the next one.
    }
    const continuation = session.continueWithInput({ request: "follow-up request" });
    const firstContinuationEvent = await session.events[Symbol.asyncIterator]().next();
    await continuation;
    const continuationBoundary = await session.waitForBoundary();
    assert.equal(continuationBoundary.status, "awaiting_bus");

    const store = new RunStore(runRoot);
    const state = await store.loadState(session.runId);
    const events = await store.loadEvents(session.runId);

    assert.equal(state.status, "awaiting_bus");
    assert.equal(firstContinuationEvent.done, false);
    assert.equal(firstContinuationEvent.value?.type, "run_continued");
    assert.equal(state.rework_count, 1);
    assert.deepEqual(state.suspended_stack, []);
    assert.deepEqual(requests.map((request) => request.context?.nodeId), ["product", "dev", "dev", "product", "dev"]);
    assert.deepEqual(state.attempts.map((attempt) => [attempt.node_id, attempt.attempt, attempt.activation]), [
      ["product", 1, 2],
      ["dev", 1, 3]
    ]);
    assert.equal(events.filter((event) => event.type === "run_started").length, 1);
    assert.equal(events.filter((event) => event.type === "run_continued").length, 1);
    assert.equal(events.filter((event) => event.type === "run_completed").length, 1);
  });

  it("restores a stale running session as waiting for user input without invoking the provider", async () => {
    let calls = 0;
    const runRoot = `.tmp/session-resume-stale-running-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const store = new RunStore(runRoot);
    const run = await store.createRun("flow", { request: "x" });
    const teamConfig = config();
    await store.saveState(run.runId, {
      version: 2,
      status: "running",
      workflow_id: "flow",
      current_node_id: "dev",
      attempts: [{ node_id: "dev", attempt: 1, activation: 1, status: "running", activations: [{ activation: 1, status: "running" }] }],
      handoff: { request: "x" },
      resume_checkpoint: { node_id: "dev", handoff: { request: "x" }, attempt: 1, activation: 1, dialogue_messages: [] },
      node_checkpoints: {},
      suspended_stack: [],
      rework_count: 0,
      rework_limit: 10
    });

    const resumed = await new WorkflowEngine({
      providerFactory: () => ({
        async generate() {
          calls += 1;
          throw new Error("provider should not be called while restoring a stale running session");
        }
      }),
      cwd: process.cwd(),
      runRoot
    }).resumeInteractive(teamConfig, run.runId);

    const boundary = await resumed.waitForBoundary();
    assert.equal(boundary.status, "paused");
    const events = await store.loadEvents(run.runId);
    const state = await store.loadState(run.runId);

    assert.equal(state.status, "paused");
    assert.equal(state.resume_checkpoint?.node_id, "dev");
    assert.equal(state.attempts.at(-1)?.status, "waiting_user");
    assert.equal(events.some((event) => event.type === "node_waiting_user"), true);
    assert.equal(events.some((event) => event.type === "run_interrupted"), false);
    assert.equal(calls, 0);
  });

  it("resumes an interactive session after a node returns failure and user provides rework input", async () => {
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          return { content: JSON.stringify({ direction: "backward", summary: "rejected: missing details", feedback: { defects: ["incomplete"], change_requests: [] }, handoff: { instruction: "rework" } }) };
        }
        return { content: JSON.stringify({ direction: "forward", summary: "rework accepted", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/session-failure-rework-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });
    const iterator = session.events[Symbol.asyncIterator]();

    for (;;) {
      const event = await nextEventWithTimeout(iterator);
      if (event.type === "node_waiting_user") break;
    }

    const waitingBoundary = await session.waitForBoundary();
    assert.equal(waitingBoundary.status, "paused");
    const store = new RunStore(runRoot);
    const state = await store.loadState(session.runId);
    assert.equal(state.status, "paused");
    assert.equal(state.attempts.at(-1)?.status, "failure");

    await session.resumeWithUserInput({ answer: "adding required context for rework" });
    const resumedBoundary = await session.waitForBoundary();
    assert.equal(resumedBoundary.status, "awaiting_bus");
    await session.finalize("test summary");

    const result = await session.result;
    assert.equal(result.status, "completed");
    assert.equal(result.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 2);

    const reworkMessages = requests[1]?.messages.filter((m) => m.role === "user");
    const reworkText = reworkMessages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join(" ");
    assert.match(reworkText, /adding required context for rework/);
  });

  it("replays a manually paused run as waiting for user input without invoking the provider", async () => {
    let release!: () => void;
    let calls = 0;
    const blockingProvider: ModelProvider = {
      async generate() {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: JSON.stringify({ direction: "forward", summary: "old", handoff: { instruction: "old" } }) };
      }
    };
    const runRoot = `.tmp/session-resume-paused-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => blockingProvider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    for await (const event of session.events) {
      if (event.type === "node_started") break;
    }
    await waitUntil(() => typeof release === "function");
    const interruption = session.interrupt();
    release();
    await interruption;
    const interruptedBoundary = await session.waitForBoundary();
    assert.equal(interruptedBoundary.status, "paused");

    const resumed = await new WorkflowEngine({
      providerFactory: () => ({
        async generate() {
          throw new Error("provider should not be called while restoring paused session");
        }
      }),
      cwd: process.cwd(),
      runRoot
    }).resumeInteractive(config(), session.runId);
    const iterator = resumed.events[Symbol.asyncIterator]();
    const events: string[] = [];
    for (;;) {
      const event = await nextEventWithTimeout(iterator);
      events.push(event.type);
      if (event.type === "node_waiting_user") break;
    }

    const resumedBoundary = await resumed.waitForBoundary();
    assert.equal(resumedBoundary.status, "paused");
    const state = await new RunStore(runRoot).loadState(session.runId);
    assert.equal(state.status, "paused");
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 1);
    assert.equal(events.includes("node_waiting_user"), true);
    assert.equal(events.includes("run_interrupted"), false);
  });

  it("injects queued user input into the running node at a model boundary", async () => {
    let calls = 0;
    let firstRequestStarted = false;
    let releaseFirst!: () => void;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          firstRequestStarted = true;
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { content: JSON.stringify({ direction: "forward", summary: "first", handoff: { instruction: "old" } }) };
        }
        const userText = request.messages
          .filter((message) => message.role === "user")
          .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
          .join(" ");
        assert.match(userText, /follow-up while running/);
        return { content: JSON.stringify({ direction: "forward", summary: "updated", handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/session-active-input-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const session = await new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot })
      .startInteractive(config(), "flow", { request: "initial" });

    await waitUntil(() => firstRequestStarted && typeof releaseFirst === "function");
    assert.ok(session.queueUserInput);
    const receipt = await session.queueUserInput({ request: "follow-up while running" }, "input-running-1");
    assert.deepEqual(receipt, { id: "input-running-1", disposition: "active_turn" });
    releaseFirst();

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    await session.finalize("test summary");
    const result = await session.result;
    const events = await new RunStore(runRoot).loadEvents(session.runId);
    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      events.filter((event) => event.type === "user_input_injected").map((event) => event.input_id),
      ["input-running-1"]
    );
  });

  it("persists node reassignment before execution and preserves inline images", async () => {
    let calls = 0;
    let secondRequestStarted = false;
    let releaseSecondRequest!: () => void;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        requests.push(request);
        if (calls === 2) {
          secondRequestStarted = true;
          await new Promise<void>((resolve) => {
            releaseSecondRequest = resolve;
          });
        }
        return {
          content: JSON.stringify({
            direction: "forward",
            summary: `call ${calls}`,
            handoff: { instruction: "done" }
          })
        };
      }
    };
    const runRoot = `.tmp/session-bus-dispatch-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const workflowConfig = {
      providers: {
        default: {
          type: "openai-compatible" as const,
          base_url: "https://api.example.test/v1",
          api_key: "test-key",
          default_model: "gpt-test",
          capabilities: { tool_calling: false, vision: true, streaming: false, json_schema_output: true }
        }
      },
      dispatcher: testDispatcher,
      roles: {
        dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
      },
      workflows: {
        flow: {
          nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }],
          edges: []
        }
      }
    };
    const session = await new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot })
      .startInteractive(workflowConfig, "flow", { request: "initial" });

    const initialBoundary = await session.waitForBoundary();
    assert.equal(initialBoundary.status, "awaiting_bus");

    await session.dispatchToNode("dev", {
      request: "inspect the attached image",
      images: [{ type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }]
    }, {
      reason: "Bus requested image verification",
      countsAsRework: true,
      permissionMode: "fullAccess"
    });
    await waitUntil(() => secondRequestStarted);

    assert.equal(session.state.status, "running");
    assert.equal(session.state.current_node_id, "dev");
    assert.equal(session.state.rework_count, 1);
    assert.equal(session.state.run_permission_mode, "fullAccess");
    releaseSecondRequest();

    const boundary = await session.waitForBoundary();
    assert.equal(boundary.status, "awaiting_bus");
    const imagePart = requests[1]?.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => part.type === "image");
    assert.deepEqual(imagePart, {
      type: "image",
      media_type: "image/png",
      data: "iVBORw0KGgo="
    });
    await session.finalize("test summary");
    assert.equal((await session.result).status, "completed");
  });

});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for provider execution");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
async function nextEventWithTimeout<T>(iterator: AsyncIterator<T>): Promise<T> {

  const result = await Promise.race([

    iterator.next(),

    new Promise<IteratorResult<T>>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for session event")), 250))

  ]);

  if (result.done) throw new Error("Session event stream ended unexpectedly");

  return result.value;

}

function twoNodeConfig() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    dispatcher: testDispatcher,
    roles: {
      product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }
  };
}

function config() {
  return {

    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key: "test-key", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },

    dispatcher: testDispatcher,
    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },

    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }

  };

}

import { describe, it } from "node:test";



import assert from "node:assert/strict";



import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider } from "../../src/providers/types.js";
import { RunStore } from "../../src/storage/runStore.js";




describe("WorkflowSession", () => {



  it("streams events and resolves a completed result", async () => {



    const provider: ModelProvider = {



      async generate() {



        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };



      }



    };



    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-runs" });



    const session = await engine.startInteractive(config(), "flow", { request: "x" });







    const seen: string[] = [];



    for await (const event of session.events) {



      seen.push(event.type);



      if (event.type === "node_completed") break;



    }







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



        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };



      }



    };



    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-interrupt-runs" });



    const session = await engine.startInteractive(config(), "flow", { request: "x" });







    for await (const event of session.events) {



      if (event.type === "node_started") break;



    }







    await session.interrupt();



    release();







    await promiseSettlesSoon(session.result);



    const store = new RunStore(".tmp/session-interrupt-runs");
    const state = await store.loadState(session.runId);
    assert.equal(state.status, "waiting_user");
    assert.equal(state.attempts.at(-1)?.status, "waiting_user");
  });

  it("continues an interrupted session from the checkpoint node", async () => {
    let calls = 0;
    let release!: () => void;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ status: "success", summary: "planned", handoff: { instruction: "build" } }) };
        }
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { content: JSON.stringify({ status: "success", summary: "ignored after interrupt", handoff: { instruction: "old" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: "resumed dev", handoff: { instruction: "done" } }) };
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

    await session.interrupt();
    release();
    await promiseSettlesSoon(session.result);
    const interruptedState = await new RunStore(runRoot).loadState(session.runId);
    assert.equal(interruptedState.status, "waiting_user");

    await session.resumeWithUserInput({ answer: "resume from here" });

    const store = new RunStore(runRoot);
    const events = await store.loadEvents(session.runId);
    const starts = events.filter((event) => event.type === "node_started").map((event) => `${event.node_id}:${event.attempt}`);
    const userMessages = events.filter((event) => event.type === "user_message");
    const state = await store.loadState(session.runId);

    assert.deepEqual(starts, ["product:1", "dev:1", "dev:2"]);
    assert.equal(events.filter((event) => event.type === "run_started").length, 1);
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]?.node_id, "dev");
    assert.equal(state.status, "completed");
    assert.equal(state.resume_checkpoint, undefined);
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "product").length, 1);
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "dev").length, 2);
    assert.equal(calls, 3);
  });

  it("continues from the next node when interrupted immediately after a plan transition", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ status: "success", summary: "plan", document: "# Plan", handoff: { instruction: "build" } }) };
        }
        return { content: JSON.stringify({ status: "success", summary: `dev ${calls}`, handoff: { instruction: "done" } }) };
      }
    };
    const runRoot = `.tmp/session-plan-transition-interrupt-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(planConfig(), "flow", { request: "x" });
    const iterator = session.events[Symbol.asyncIterator]();

    for (;;) {
      const event = await nextEventWithTimeout(iterator);
      if (event.type === "plan_review_requested") break;
    }

    const resume = session.resumePlanReview("continue");
    await session.interrupt();
    await assert.doesNotReject(resume);
    await promiseSettlesSoon(session.result);
    const interruptedState = await new RunStore(runRoot).loadState(session.runId);
    assert.equal(interruptedState.status, "waiting_user");

    await session.resumeWithUserInput({ answer: "resume dev" });

    const store = new RunStore(runRoot);
    const events = await store.loadEvents(session.runId);
    const starts = events.filter((event) => event.type === "node_started").map((event) => `${event.node_id}:${event.attempt}`);
    const userMessages = events.filter((event) => event.type === "user_message");
    const state = await store.loadState(session.runId);

    assert.equal(starts[0], "product:1");
    assert.equal(starts.at(-1), "dev:1");
    assert.equal(userMessages[0]?.node_id, "dev");
    assert.equal(state.status, "completed");
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "product").length, 1);
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 2);
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



    await promiseSettlesSoon(session.result);



  });















  it("streams plan review requests and resumes directly after approval", async () => {



    let calls = 0;



    const provider: ModelProvider = {



      async generate() {



        calls += 1;



        if (calls === 1) {



          return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Plan\nDo it.", handoff: { instruction: "approved work" } }) };



        }



        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };



      }



    };



    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-plan-review-runs" });



    const session = await engine.startInteractive(planConfig(), "flow", { request: "x" });



    const iterator = session.events[Symbol.asyncIterator]();







    for (;;) {



      const event = await nextEventWithTimeout(iterator);



      if (event.type === "plan_review_requested") {



        assert.match(event.document, /Do it/);



        break;



      }



    }







    await session.resumePlanReview("continue");



    const result = await session.result;







    assert.equal(result.status, "completed");



    assert.deepEqual(result.attempts.map((attempt) => `${attempt.node_id}:${attempt.status}`), ["product:success", "dev:success"]);



    assert.equal(calls, 2);



  });







  it("streams a revised plan after the user pauses and submits changes", async () => {



    let calls = 0;



    const provider: ModelProvider = {



      async generate() {



        calls += 1;



        if (calls === 1) return { content: JSON.stringify({ status: "success", summary: "plan ready", document: "# Plan\nOld plan.", handoff: { instruction: "old" } }) };



        return { content: JSON.stringify({ status: "success", summary: "revised plan", document: "# Plan\nRevised plan.", handoff: { instruction: "revised" } }) };



      }



    };



    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-plan-revision-runs" });



    const session = await engine.startInteractive(planConfig(), "flow", { request: "x" });



    const iterator = session.events[Symbol.asyncIterator]();







    for (;;) {



      const event = await nextEventWithTimeout(iterator);



      if (event.type === "plan_review_requested") break;



    }







    await session.resumePlanReview("stay");



    await session.revisePlan({ answer: "请把计划拆得更细" });







    const seen: string[] = [];



    let revised = "";



    for (;;) {



      const event = await nextEventWithTimeout(iterator);



      seen.push(event.type);



      if (event.type === "plan_review_requested") {



        revised = event.document;



        break;



      }



    }







    assert.equal(calls, 2);



    assert.equal(seen.includes("user_message"), true);



    assert.match(revised, /Revised plan/);



    await session.interrupt();



    await promiseSettlesSoon(session.result);



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



    await promiseSettlesSoon(session.result);
    const store = new RunStore(runRoot);
    const state = await store.loadState(session.runId);
    const events = await store.loadEvents(session.runId);



    assert.equal(state.status, "waiting_user");
    assert.equal(state.current_node_id, "dev");
    assert.equal(state.attempts.at(-1)?.status, "failure");
    assert.equal(events.some((event) => event.type === "node_completed" && event.status === "failure"), true);
    assert.equal(events.some((event) => event.type === "node_waiting_user"), true);
    assert.equal(events.some((event) => event.type === "run_failed"), false);
    assert.equal(seen.includes("node_waiting_user"), true);



  });







  it("resumes an interactive session after user input is requested", async () => {



    let calls = 0;



    const provider: ModelProvider = {



      async generate() {



        calls += 1;



        if (calls === 1) {



          return { content: JSON.stringify({ status: "needs_user_input", summary: "need detail", questions: [{ id: "q1", text: "Target?", required: true }] }) };



        }



        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };



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







    const result = await session.result;



    assert.equal(result.status, "completed");



    assert.equal(result.attempts.filter((attempt) => attempt.node_id === "dev").length, 2);



    assert.equal(seen.includes("user_message"), true);



  });







  it("replays a completed run without invoking the provider again", async () => {



    let calls = 0;



    const provider: ModelProvider = {



      async generate() {



        calls += 1;



        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };



      }



    };



    const runRoot = ".tmp/session-resume-completed-runs";



    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });



    const original = await engine.startInteractive(config(), "flow", { request: "x" });



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



    const resumed = await replayEngine.resumeInteractive(config(), original.runId);



    const events: string[] = [];



    for await (const event of resumed.events) events.push(event.type);







    assert.equal((await resumed.result).status, "completed");



    assert.deepEqual(events.filter((event) => event === "run_started"), ["run_started"]);



  });







  it("restores a stale running session as waiting for user input without invoking the provider", async () => {
    let calls = 0;
    const runRoot = `.tmp/session-resume-stale-running-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const store = new RunStore(runRoot);
    const run = await store.createRun("flow", { request: "x" });
    await store.saveState(run.runId, {
      status: "running",
      workflow_id: "flow",
      current_node_id: "dev",
      attempts: [{ node_id: "dev", attempt: 1, status: "running" }],
      handoff: { request: "x" },
      resume_checkpoint: { node_id: "dev", handoff: { request: "x" } }
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
    }).resumeInteractive(config(), run.runId);

    await promiseSettlesSoon(resumed.result);
    const events = await store.loadEvents(run.runId);
    const state = await store.loadState(run.runId);

    assert.equal(state.status, "waiting_user");
    assert.equal(state.resume_checkpoint?.node_id, "dev");
    assert.equal(state.attempts.at(-1)?.status, "waiting_user");
    assert.equal(events.some((event) => event.type === "node_waiting_user"), true);
    assert.equal(events.some((event) => event.type === "run_interrupted"), false);
    assert.equal(calls, 0);
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
        return { content: JSON.stringify({ status: "success", summary: "old", handoff: { instruction: "old" } }) };
      }
    };
    const runRoot = `.tmp/session-resume-paused-runs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const engine = new WorkflowEngine({ providerFactory: () => blockingProvider, cwd: process.cwd(), runRoot });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    for await (const event of session.events) {
      if (event.type === "node_started") break;
    }
    await session.interrupt();
    release();
    await promiseSettlesSoon(session.result);

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

    await promiseSettlesSoon(resumed.result);
    const state = await new RunStore(runRoot).loadState(session.runId);
    assert.equal(state.status, "waiting_user");
    assert.equal(state.attempts.filter((attempt) => attempt.node_id === "dev").length, 1);
    assert.equal(calls, 1);
    assert.equal(events.includes("node_waiting_user"), true);
    assert.equal(events.includes("run_interrupted"), false);
  });

});















async function promiseSettlesSoon<T>(promise: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50))
  ]);
}

async function promiseWithTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for session result")), 250))
  ]);
}

async function nextEventWithTimeout<T>(iterator: AsyncIterator<T>): Promise<T> {



  const result = await Promise.race([



    iterator.next(),



    new Promise<IteratorResult<T>>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for session event")), 250))



  ]);



  if (result.done) throw new Error("Session event stream ended unexpectedly");



  return result.value;



}











function planConfig() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },



    roles: {



      product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },



      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }



    },



    workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const, mode: "plan" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }



  };
}

function twoNodeConfig() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: {
      product: { description: "", system_prompt: "P", requires: { tool_calling: false, vision: false } },
      dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } }
    },
    workflows: { flow: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }, { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [{ from: "product", to: "dev", condition: "success" as const }] } }
  };
}

function config() {
  return {



    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },



    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },



    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }



  };



}

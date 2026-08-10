import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { EventStream } from "../../src/harness/eventStream.js";
import type { ModelProvider } from "../../src/providers/types.js";
import type { WorkflowState } from "../../src/workflow/state.js";
import { testBusProviderFactory, testDispatcher } from "../helpers/projectConfig.js";

const config = {
  providers: {
    default: {
      type: "openai-compatible" as const,
      base_url: "https://api.example.test/v1",
      api_key: "test-key",
      default_model: "gpt-test",
      capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
    }
  },
  dispatcher: testDispatcher,
  roles: {
    dev: { description: "", system_prompt: "dev", requires: { tool_calling: false, vision: false } }
  },
  workflows: {
    delivery: {
      nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }],
      edges: []
    }
  }
};

let cwdSequence = 0;

describe("TuiApp session continuation", () => {
  it("does not enter Plan Mode when an ordinary bus response requests planning", async (t) => {
    let starts = 0;
    const engine = {
      async startInteractive() {
        starts += 1;
        return createRunningSession().session;
      }
    };
    const provider: ModelProvider = {
      async generate() {
        return {
          content: JSON.stringify({
            type: "plan",
            confidence: 1,
            node_id: "dev",
            reason: "Plan unexpectedly"
          })
        };
      }
    };
    const output = renderTui(engine, () => provider);
    t.after(() => {
      output.unmount();
      output.cleanup();
    });

    await sendTuiLine(output, "ordinary request");
    await waitFor(() => (output.lastFrame() ?? "").includes("调度模型没有返回可验证的路由决策"));

    assert.equal(starts, 0);
    assert.doesNotMatch(output.lastFrame() ?? "", /\| plan \|/);
  });

  it("routes later ordinary input through the bus and receives asynchronous workflow state events", async (t) => {
    const queuedInputs: unknown[] = [];
    const initialInputs: unknown[] = [];
    const fixture = createRunningSession({
      queueUserInput: async (input) => {
        queuedInputs.push(input);
        const request = requestFromBusInput(input);
        fixture.push({ type: "user_input_injected", input_id: "input-1", text: request, node_id: "dev", attempt: 1, activation: 1 });
        fixture.push({ type: "node_started", node_id: "dev", attempt: 1, activation: 2 });
        fixture.push({ type: "model_stream_delta", node_id: "dev", attempt: 1, activation: 2, text: "我继续处理第二轮。" });
        return { id: "input-1", disposition: "active_turn" as const };
      }
    });
    let starts = 0;
    const engine = {
      async startInteractive(_config: unknown, _workflowId: string, input: unknown) {
        starts += 1;
        initialInputs.push(input);
        return fixture.session;
      }
    };
    const output = renderTui(engine);
    t.after(() => {
      fixture.close();
      output.unmount();
      output.cleanup();
    });

    await sendTuiLine(output, "first request");
    await waitFor(() => starts === 1);
    await sendTuiLine(output, "second request");
    await waitFor(
      () => queuedInputs.length === 1 && (output.lastFrame() ?? "").includes("running #1.2"),
      () => `queued=${JSON.stringify(queuedInputs)} subscriptions=${fixture.subscriptions()} frame=${output.lastFrame() ?? ""}`
    );

    assert.equal(starts, 1);
    assert.deepEqual(userInputFromBus(initialInputs[0]), { request: "first request", images: [] });
    assert.deepEqual(userInputFromBus(queuedInputs[0]), { request: "second request", images: [] });
    assert.deepEqual(fixture.legacyContinues, []);

  });

  it("serializes queued prompts through the bus in FIFO order", async (t) => {
    const queuedInputs: unknown[] = [];
    const fixture = createRunningSession({
      queueUserInput: async (input) => {
        queuedInputs.push(input);
        return { id: `input-${queuedInputs.length}`, disposition: "active_turn" as const };
      }
    });
    let starts = 0;
    const engine = {
      async startInteractive() {
        starts += 1;
        return fixture.session;
      }
    };
    const output = renderTui(engine);
    t.after(() => {
      fixture.close();
      output.unmount();
      output.cleanup();
    });

    await sendTuiLine(output, "first request");
    await waitFor(() => starts === 1);
    await sendTuiLine(output, "queued one");
    await sendTuiLine(output, "queued two");
    await waitFor(() => queuedInputs.length === 2);

    assert.deepEqual(queuedInputs.map(requestFromBusInput), ["queued one", "queued two"]);
    assert.deepEqual(fixture.legacyContinues, []);

  });

  it("turns workflow reassignment failures into bus clarification", async (t) => {
    let dispatches = 0;
    const fixture = createRunningSession({
      dispatchToNode: async () => {
        dispatches += 1;
        throw new Error("continuation failed");
      }
    });
    let starts = 0;
    const engine = {
      async startInteractive() {
        starts += 1;
        return fixture.session;
      }
    };
    const output = renderTui(engine);
    t.after(() => {
      fixture.close();
      output.unmount();
      output.cleanup();
    });

    await sendTuiLine(output, "first request");
    await waitFor(() => starts === 1);
    await sendTuiLine(output, "keep this request");
    await waitFor(
      () => dispatches === 1 && (output.lastFrame() ?? "").includes("Waiting |"),
      () => `dispatches=${dispatches} subscriptions=${fixture.subscriptions()} frame=${output.lastFrame() ?? ""}`
    );

    assert.equal(starts, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(fixture.legacyContinues, []);

  });

  it("routes a prompt after Escape through bus-managed workflow resume", async (t) => {
    const resumedInputs: unknown[] = [];
    let interrupts = 0;
    let fixture!: ReturnType<typeof createRunningSession>;
    fixture = createRunningSession({
      interrupt: async () => {
        interrupts += 1;
        fixture.setState({ status: "waiting_user" });
        fixture.push({ type: "run_interrupted" });
      },
      resumeWithUserInput: async (input) => {
        resumedInputs.push(input);
        fixture.setState({ status: "running" });
        fixture.push({ type: "user_message", text: "continue after interrupt", node_id: "dev", attempt: 1 });
        fixture.push({ type: "node_started", node_id: "dev", attempt: 1, activation: 2 });
        fixture.push({ type: "model_stream_delta", node_id: "dev", attempt: 1, activation: 2, text: "节点已恢复执行。" });
      }
    });
    let starts = 0;
    const engine = {
      async startInteractive() {
        starts += 1;
        return fixture.session;
      }
    };
    const output = renderTui(engine);
    t.after(() => {
      fixture.close();
      output.unmount();
      output.cleanup();
    });

    await sendTuiLine(output, "first request");
    await waitFor(() => starts === 1 && fixture.subscriptions() > 0);
    output.stdin.write("\u001b");
    await waitFor(() => interrupts === 1);
    await sendTuiLine(output, "continue after interrupt");
    await waitFor(
      () => resumedInputs.length === 1,
      () => `interrupts=${interrupts} resumed=${JSON.stringify(resumedInputs)} frame=${output.lastFrame() ?? ""}`
    );
    await waitFor(
      () => (output.lastFrame() ?? "").includes("running #1.2"),
      () => `resumed=${JSON.stringify(resumedInputs)} subscriptions=${fixture.subscriptions()} frame=${output.lastFrame() ?? ""}`
    );

    assert.equal(starts, 1);
    assert.deepEqual(userInputFromBus(resumedInputs[0]), { answer: "continue after interrupt", images: [] });
    assert.deepEqual(fixture.legacyContinues, []);

  });
});

class CountingEventStream extends EventStream<any> {
  subscriptions = 0;

  override [Symbol.asyncIterator](): AsyncIterator<any> {
    this.subscriptions += 1;
    return super[Symbol.asyncIterator]();
  }
}

type RunningSessionHooks = {
  queueUserInput?: (input: unknown) => Promise<{ id: string; disposition: "active_turn" | "next_turn" }>;
  dispatchToNode?: (nodeId: string, input: unknown) => Promise<void>;
  resumeWithUserInput?: (input: unknown) => Promise<void>;
  interrupt?: () => Promise<void>;
};

function createRunningSession(hooks: RunningSessionHooks = {}) {
  const events = new CountingEventStream();
  const listeners = new Set<(state: WorkflowState) => void>();
  const legacyContinues: unknown[] = [];
  const state: WorkflowState = {
    status: "running",
    workflow_id: "delivery",
    current_node_id: "dev",
    attempts: [],
    handoff: undefined
  };
  let sequence = 0;
  let resolveResult!: (state: WorkflowState) => void;
  const result = new Promise<WorkflowState>((resolve) => {
    resolveResult = resolve;
  });
  const setState = (update: Partial<WorkflowState>) => {
    Object.assign(state, update);
    for (const listener of listeners) listener({ ...state });
  };
  const push = (event: Record<string, unknown>) => {
    sequence += 1;
    events.push({ ...event, ts: `2026-06-26T00:00:${String(sequence).padStart(2, "0")}.000Z`, seq: sequence });
  };
  const session = {
    runId: `run-${++cwdSequence}`,
    state,
    events,
    permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
    interrupt: async () => hooks.interrupt?.(),
    resumeWithUserInput: async (input: unknown) => hooks.resumeWithUserInput?.(input),
    continueWithInput: async (input: unknown) => {
      legacyContinues.push(input);
    },
    dispatchToNode: async (nodeId: string, input: unknown) => hooks.dispatchToNode?.(nodeId, input),
    finalize: async (summary: string) => {
      setState({ status: "completed", final_summary: summary });
      resolveResult({ ...state });
    },
    subscribeState: (listener: (next: WorkflowState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForBoundary: async () => ({ ...state }),
    ...(hooks.queueUserInput ? { queueUserInput: hooks.queueUserInput } : {}),
    result
  };
  return { session, legacyContinues, push, setState, subscriptions: () => events.subscriptions, close: () => events.end() };
}

function renderTui(
  engine: unknown,
  providerFactory: (providerId: string) => ModelProvider = testBusProviderFactory("dev")
) {
  const cwd = join(process.cwd(), ".tmp", "continue-session", String(++cwdSequence));
  return render(
    <TuiApp
      cwd={cwd}
      config={config as never}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={providerFactory}
    />
  );
}

function userInputFromBus(input: unknown): unknown {
  return input && typeof input === "object" && "user_input" in input
    ? (input as { user_input: unknown }).user_input
    : undefined;
}

function requestFromBusInput(input: unknown): string {
  const userInput = userInputFromBus(input);
  if (!userInput || typeof userInput !== "object" || !("request" in userInput)) return "";
  return String((userInput as { request: unknown }).request);
}

async function sendTuiLine(output: { stdin: { write(value: string): void } }, text: string): Promise<void> {
  output.stdin.write(text);
  await settleTuiWork();
  output.stdin.write("\r");
  await settleTuiWork();
}

function settleTuiWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(condition: () => boolean, detail?: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await settleTuiWork();
  }
  throw new Error(`Timed out waiting for TUI bus continuation${detail ? `\n${detail()}` : ""}`);
}

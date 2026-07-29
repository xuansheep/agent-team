import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { EventStream } from "../../src/harness/eventStream.js";

const config = {
  workflows: { delivery: { nodes: [] } },
  roles: {},
  providers: {}
};

describe("TuiApp session continuation", () => {
  it("receives continuation events when the provider work starts asynchronously", async () => {
    let starts = 0;
    const resumed: unknown[] = [];
    const continued: unknown[] = [];
    const completedState = { status: "completed" as const, workflow_id: "delivery", attempts: [], handoff: undefined };
    let resolveResult!: (value: typeof completedState) => void;
    const result = new Promise<typeof completedState>((resolve) => {
      resolveResult = resolve;
    });
    const events = new CountingEventStream();
    const session = {
      runId: "run-continue",
      state: { ...completedState, status: "running" as const },
      events,
      permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
      interrupt: async () => undefined,
      resumeWithUserInput: async (input: unknown) => {
        resumed.push(input);
        throw new Error("completed run must not resume as waiting for user input");
      },
      continueWithInput: (input: unknown) => {
        continued.push(input);
        events.reopen();
        return (async () => {
          await settleTuiWork();
          events.push({ type: "user_message", text: "second request", node_id: "dev", attempt: 1, ts: "2026-06-26T00:00:02.000Z", seq: 3 });
          events.push({ type: "node_started", node_id: "dev", attempt: 1, activation: 2, ts: "2026-06-26T00:00:03.000Z", seq: 4 });
          events.push({ type: "model_stream_delta", node_id: "dev", attempt: 1, activation: 2, text: "我继续处理第二轮。", ts: "2026-06-26T00:00:04.000Z", seq: 5 });
          events.push({ type: "run_completed", result: completedState, ts: "2026-06-26T00:00:05.000Z", seq: 6 });
          events.end();
        })();
      },
      result
    };
    const engine = {
      async startInteractive() {
        starts += 1;
        return session;
      }
    };

    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={config as never} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);
    await settleTuiWork();

    await sendTuiLine(output, "first request");
    events.push({ type: "run_started", workflow_id: "delivery", input: { request: "first request" }, ts: "2026-06-26T00:00:00.000Z", seq: 1 });
    events.push({ type: "run_completed", result: completedState, ts: "2026-06-26T00:00:01.000Z", seq: 2 });
    events.end();
    await settleTuiWork();
    resolveResult(completedState);
    await settleTuiWork();
    await sendTuiLine(output, "second request");

    await settleTuiWork();

    assert.equal(starts, 1);
    assert.deepEqual(resumed, []);
    assert.deepEqual(continued, [{ request: "second request", images: [] }]);
    assert.equal(events.subscriptions, 2);
    assert.match(output.lastFrame() ?? "", /我继续处理第二轮。/);

    output.unmount();
    output.cleanup();
  });

  it("automatically drains queued prompts in FIFO order after each completed segment", async () => {
    let starts = 0;
    let sequence = 2;
    const continued: unknown[] = [];
    const completedState = { status: "completed" as const, workflow_id: "delivery", attempts: [], handoff: undefined };
    let resolveInitialResult!: (value: typeof completedState) => void;
    const events = new CountingEventStream();
    const result = new Promise<typeof completedState>((resolve) => {
      resolveInitialResult = resolve;
    });
    const session = {
      runId: "run-queued",
      state: { ...completedState, status: "running" as const },
      events,
      permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
      interrupt: async () => undefined,
      resumeWithUserInput: async () => undefined,
      continueWithInput: (input: unknown) => {
        continued.push(input);
        events.reopen();
        const request = (input as { request?: string }).request ?? "";
        return (async () => {
          await settleTuiWork();
          events.push({ type: "user_message", text: request, node_id: "dev", attempt: 1, ts: `2026-06-26T00:00:0${sequence++}.000Z`, seq: sequence });
          events.push({ type: "node_started", node_id: "dev", attempt: 1, activation: continued.length + 1, ts: `2026-06-26T00:00:0${sequence++}.000Z`, seq: sequence });
          events.push({ type: "model_stream_delta", node_id: "dev", attempt: 1, activation: continued.length + 1, text: `processed ${request}`, ts: `2026-06-26T00:00:0${sequence++}.000Z`, seq: sequence });
          events.push({ type: "run_completed", result: completedState, ts: `2026-06-26T00:00:0${sequence++}.000Z`, seq: sequence });
          events.end();
        })();
      },
      result
    };
    const engine = {
      async startInteractive() {
        starts += 1;
        return session;
      }
    };

    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={config as never} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);
    await sendTuiLine(output, "first request");
    await sendTuiLine(output, "queued one");
    await sendTuiLine(output, "queued two");

    assert.match(output.lastFrame() ?? "", /queued 1: queued one/);
    assert.match(output.lastFrame() ?? "", /queued 2: queued two/);

    events.push({ type: "run_completed", result: completedState, ts: "2026-06-26T00:00:01.000Z", seq: 1 });
    events.end();
    resolveInitialResult(completedState);

    await waitFor(
      () => continued.length === 2,
      () => `continued=${JSON.stringify(continued)}\nsubscriptions=${events.subscriptions}\nstream=${JSON.stringify(events)}\nframe=${output.lastFrame() ?? ""}`
    );

    assert.equal(starts, 1);
    assert.deepEqual(continued, [
      { request: "queued one", images: [] },
      { request: "queued two", images: [] }
    ]);
    assert.doesNotMatch(output.lastFrame() ?? "", /queued [12]:/);

    output.unmount();
    output.cleanup();
  });

  it("restores a queued prompt when continuation fails", async () => {
    const continued: unknown[] = [];
    const completedState = { status: "completed" as const, workflow_id: "delivery", attempts: [], handoff: undefined };
    let resolveInitialResult!: (value: typeof completedState) => void;
    const events = new CountingEventStream();
    const result = new Promise<typeof completedState>((resolve) => {
      resolveInitialResult = resolve;
    });
    const session = {
      runId: "run-queue-failure",
      state: { ...completedState, status: "running" as const },
      events,
      permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
      interrupt: async () => undefined,
      resumeWithUserInput: async () => undefined,
      continueWithInput: (input: unknown) => {
        continued.push(input);
        events.reopen();
        return Promise.reject(new Error("continuation failed"));
      },
      result
    };
    const engine = {
      async startInteractive() {
        return session;
      }
    };

    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={config as never} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);
    await sendTuiLine(output, "first request");
    await sendTuiLine(output, "keep this request");

    events.push({ type: "run_completed", result: completedState, ts: "2026-06-26T00:00:01.000Z", seq: 1 });
    events.end();
    resolveInitialResult(completedState);

    await waitFor(() => continued.length === 1);
    await settleTuiWork();

    assert.deepEqual(continued, [{ request: "keep this request", images: [] }]);
    assert.match(output.lastFrame() ?? "", /continuation failed/);
    assert.match(output.lastFrame() ?? "", /queued 1: keep this request/);

    output.unmount();
    output.cleanup();
  });

  it("routes an immediate prompt after Escape through interactive resume", async () => {
    const resumed: unknown[] = [];
    const continued: unknown[] = [];
    let interrupts = 0;
    const state = { status: "running" as const, workflow_id: "delivery", current_node_id: "dev", attempts: [], handoff: undefined };
    const events = new CountingEventStream();
    events.push({ type: "run_started", workflow_id: "delivery", input: { request: "first request" }, ts: "2026-06-26T00:00:00.000Z", seq: 1 });
    events.push({ type: "node_started", node_id: "dev", attempt: 1, activation: 1, ts: "2026-06-26T00:00:01.000Z", seq: 2 });
    const session = {
      runId: "run-interrupted",
      state,
      events,
      permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
      interrupt: async () => {
        interrupts += 1;
      },
      resumeWithUserInput: async (input: unknown) => {
        resumed.push(input);
        events.push({ type: "user_message", text: "continue after interrupt", node_id: "dev", attempt: 1, ts: "2026-06-26T00:00:02.000Z", seq: 3 });
        events.push({ type: "model_stream_delta", node_id: "dev", attempt: 1, text: "节点已恢复执行。", ts: "2026-06-26T00:00:03.000Z", seq: 4 });
      },
      continueWithInput: async (input: unknown) => {
        continued.push(input);
      },
      result: new Promise<never>(() => undefined)
    };
    const engine = {
      async startInteractive() {
        return session;
      }
    };

    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={config as never} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);
    await sendTuiLine(output, "first request");

    output.stdin.write("\u001b");
    await settleTuiWork();
    await sendTuiLine(output, "continue after interrupt");
    await settleTuiWork();

    assert.equal(interrupts, 1);
    assert.deepEqual(resumed, [{ answer: "continue after interrupt" }]);
    assert.deepEqual(continued, []);
    assert.match(output.lastFrame() ?? "", /continue after interrupt/);
    assert.match(output.lastFrame() ?? "", /节点已恢复执行/);

    output.unmount();
    output.cleanup();
  });
});

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await settleTuiWork();
  }
  throw new Error(`Timed out waiting for TUI continuation${detail ? `\n${detail()}` : ""}`);
}

class CountingEventStream extends EventStream<any> {
  subscriptions = 0;

  override [Symbol.asyncIterator](): AsyncIterator<any> {
    this.subscriptions += 1;
    return super[Symbol.asyncIterator]();
  }
}

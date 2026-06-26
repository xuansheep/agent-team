import React from "react";
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
  it("does not subscribe to the same session events stream again when continuing after completion", async () => {
    let starts = 0;
    const continued: unknown[] = [];
    const state = { status: "completed" as const, workflow_id: "delivery", attempts: [], handoff: undefined };
    const events = new CountingEventStream();
    events.push({ type: "run_started", workflow_id: "delivery", input: { request: "first request" }, ts: "2026-06-26T00:00:00.000Z", seq: 1 });
    events.push({ type: "run_completed", result: state, ts: "2026-06-26T00:00:01.000Z", seq: 2 });
    events.end();
    const session = {
      runId: "run-continue",
      state,
      events,
      permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
      interrupt: async () => undefined,
      resumeWithUserInput: async () => undefined,
      resumePlanReview: async () => undefined,
      revisePlan: async () => undefined,
      continueWithInput: async (input: unknown) => {
        continued.push(input);
        events.reopen();
        events.push({ type: "user_message", text: "second request", node_id: "dev", attempt: 1, ts: "2026-06-26T00:00:02.000Z", seq: 3 });
        events.push({ type: "model_stream_delta", node_id: "dev", attempt: 1, text: "我继续处理第二轮。", ts: "2026-06-26T00:00:03.000Z", seq: 4 });
        events.end();
      },
      result: Promise.resolve(state)
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
    await settleTuiWork();
    await sendTuiLine(output, "second request");

    await settleTuiWork();

    assert.equal(starts, 1);
    assert.deepEqual(continued, [{ request: "second request", images: [] }]);
    assert.equal(events.subscriptions, 2);
    assert.match(output.lastFrame() ?? "", /我继续处理第二轮。/);

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

class CountingEventStream extends EventStream<any> {
  subscriptions = 0;

  override [Symbol.asyncIterator](): AsyncIterator<any> {
    this.subscriptions += 1;
    return super[Symbol.asyncIterator]();
  }
}

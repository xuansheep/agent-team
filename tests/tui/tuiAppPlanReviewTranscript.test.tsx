import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";

describe("TuiApp plan review transcript", () => {
  it("renders plan review documents as transcript entries instead of a persistent bottom panel", async () => {
    const session = fakeInteractiveSession({
      runId: "run-plan-transcript",
      workflowId: "delivery",
      events: [
        {
          type: "plan_review_requested",
          node_id: "product",
          attempt: 1,
          document: "# Plan\nold plan",
          ts: "2026-06-24T00:00:00.000Z",
          seq: 1
        },
        {
          type: "model_stream_delta",
          node_id: "product",
          attempt: 1,
          text: "后续日志应该出现在计划之后。",
          ts: "2026-06-24T00:00:01.000Z",
          seq: 2
        }
      ]
    });
    const engine = { async startInteractive() { return session; } };
    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await sendTuiLine(output, "review plan");
    await settleTuiWork();

    const frame = output.lastFrame() ?? "";
    const planIndex = frame.indexOf("# Plan");
    const laterLogIndex = frame.indexOf("后续日志应该出现在计划之后。");
    assert.notEqual(planIndex, -1);
    assert.notEqual(laterLogIndex, -1);
    assert.ok(planIndex < laterLogIndex, frame);
    assert.doesNotMatch(frame, /scroll main window with mouse wheel or PageUp\/PageDown/);

    output.unmount();
    output.cleanup();
  });
});

function tuiConfig() {
  return {
    providers: {
      default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } }
    },
    roles: {
      product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } }
    },
    workflows: {
      delivery: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] }
    }
  };
}

function fakeInteractiveSession(input: { runId: string; workflowId: string; events: unknown[] }) {
  const state = { status: "running" as const, workflow_id: input.workflowId, attempts: [], handoff: undefined };
  return {
    runId: input.runId,
    state,
    events: (async function* () {
      for (const event of input.events) yield event;
    })(),
    permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
    interrupt: async () => undefined,
    resumeWithUserInput: async () => undefined,
    resumePlanReview: async () => undefined,
    revisePlan: async () => undefined,
    result: new Promise(() => undefined)
  };
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

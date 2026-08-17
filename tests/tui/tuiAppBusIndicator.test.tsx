import React from "react";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { testBusProviderFactory, testDispatcher } from "../helpers/projectConfig.js";

const config = {
  providers: {
    default: {
      type: "responses-api" as const, responses: { prompt_cache: true, parallel_tool_calls: true },
      base_url: "https://api.example.test/v1",
      api_key: "test-key",
      default_model: "gpt-test",
      capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
    }
  },
  dispatcher: testDispatcher,
  roles: {
    product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } },
    dev: { description: "", system_prompt: "dev", requires: { tool_calling: false, vision: false } }
  },
  workflows: {
    delivery: {
      nodes: [
        { id: "product", role: "product", provider: "default", permission_mode: "default" as const },
        { id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }
      ],
      edges: []
    }
  }
};

describe("TuiApp bus indicator", () => {
  it("keeps direct bus answers as one existing assistant message", async () => {
    const cwd = join(process.cwd(), ".tmp", "tui-bus-direct-answer", randomUUID());
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={{ async startInteractive() { throw new Error("workflow should not start"); } } as never}
        providerFactory={() => ({
          async generate() {
            return {
              thinking: "This can be answered without a workflow.",
              content: JSON.stringify({
                type: "answer",
                confidence: 0.99,
                message: "Direct bus answer."
              })
            };
          }
        })}
        sessionStore={new SessionStore(join(cwd, "sessions"))}
      />
    );

    assert.match(output.lastFrame() ?? "", /^bus\s*$/m);

    output.stdin.write("answer directly");
    await settle();
    output.stdin.write("\r");
    await waitForFrame(output, /Direct bus answer\./);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /This can be answered without a workflow\./);
    assert.equal((frame.match(/Direct bus answer\./g) ?? []).length, 1, frame);
    assert.doesNotMatch(frame, /Bus 选择节点/);

    output.unmount();
    output.cleanup();
  });

  it("adds bus usage to the live status once while persisting the same response once", async () => {
    const cwd = join(process.cwd(), ".tmp", "tui-bus-live-usage", randomUUID());
    const store = new SessionStore(join(cwd, "sessions"));
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={{ async startInteractive() { throw new Error("workflow should not start"); } } as never}
        providerFactory={() => ({
          async generate() {
            return {
              content: JSON.stringify({ type: "answer", confidence: 1, message: "Usage answer." }),
              usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3, totalTokens: 15 },
              stopReason: "stop" as const
            };
          }
        })}
        sessionStore={store}
      />
    );

    output.stdin.write("show usage");
    await settle();
    output.stdin.write("\r");
    await waitForFrame(output, /Usage answer\./);
    await waitForFrame(output, /tokens 12\/3/);

    const metadata = await store.loadMetadata([...await store.listSessions()][0]?.sessionId ?? "");
    assert.equal(metadata?.modelRequestCount, 1);
    assert.deepEqual(metadata?.usage, {
      inputTokens: 12,
      cachedInputTokens: 4,
      outputTokens: 3,
      totalTokens: 15
    });

    output.unmount();
    output.cleanup();
  });

  it("keeps input recoverable after a routing protocol failure", async () => {
    const cwd = join(process.cwd(), ".tmp", "tui-bus-routing-recovery", randomUUID());
    let attempt = 0;
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={{ async startInteractive() { throw new Error("workflow should not start"); } } as never}
        providerFactory={() => ({
          async generate() {
            attempt += 1;
            if (attempt <= 2) return { content: "invalid decision" };
            return {
              content: JSON.stringify({
                type: "answer",
                confidence: 1,
                message: "Recovered bus answer."
              })
            };
          }
        })}
        sessionStore={new SessionStore(join(cwd, "sessions"))}
      />
    );

    output.stdin.write("first request");
    await settle();
    output.stdin.write("\r");
    await waitForFrame(output, /Routing error:/);

    assert.match(output.lastFrame() ?? "", /调度模型连续两次未返回合法决策/);
    output.stdin.write("retry request");
    await settle();
    output.stdin.write("\r");
    await waitForFrame(output, /Recovered bus answer\./);

    assert.equal(attempt, 3);
    output.unmount();
    output.cleanup();
  });

  it("renders bus thinking and node selection as the existing model conversation logs", async () => {
    const cwd = join(process.cwd(), ".tmp", "tui-bus-conversation", randomUUID());
    const finalState = {
      status: "paused" as const,
      workflow_id: "delivery",
      current_node_id: "dev",
      attempts: [],
      questions: []
    };
    let finish!: () => void;
    const result = new Promise<typeof finalState>((resolve) => { finish = () => resolve(finalState); });
    const session = {
      runId: randomUUID(),
      state: { ...finalState, status: "running" as const },
      events: { async *[Symbol.asyncIterator]() { await result; } },
      result,
      permissions: { resolve() {}, resolveAll() {}, hasPending() { return false; } },
      interrupt: async () => { finish(); },
      resumeWithUserInput: async () => {},
      continueWithInput: async () => {},
      dispatchToNode: async () => {},
      finalize: async () => {},
      subscribeState: () => () => {},
      waitForBoundary: async () => finalState
    };
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={{ async startInteractive() { return session; } } as never}
        providerFactory={() => ({
          async generate() {
            return {
              thinking: "Checked node responsibilities.",
              content: JSON.stringify({
                type: "dispatch",
                confidence: 0.96,
                node_id: "dev",
                instruction: "Implement the requested change.",
                reason: "The task requires implementation"
              })
            };
          }
        })}
        sessionStore={new SessionStore(join(cwd, "sessions"))}
      />
    );

    output.stdin.write("implement now");
    await settle();
    output.stdin.write("\r");
    await waitForFrame(output, /Bus 选择节点 dev/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Reasoning/);
    assert.match(frame, /Checked node responsibilities\./);
    assert.match(frame, /原因：The task requires implementation/);
    assert.match(frame, /置信度：96%/);
    assert.ok(frame.indexOf("implement now") < frame.indexOf("Reasoning"));
    assert.ok(frame.indexOf("Reasoning") < frame.indexOf("Bus 选择节点 dev"));

    finish();
    output.unmount();
    output.cleanup();
  });

  it("keeps pointing at the latest bus decision after an internal workflow transition", async () => {
    const cwd = join(process.cwd(), ".tmp", "tui-bus-indicator", randomUUID());
    const finalState = {
      status: "paused" as const,
      workflow_id: "delivery",
      current_node_id: "dev",
      attempts: [],
      questions: []
    };
    let finish!: () => void;
    const result = new Promise<typeof finalState>((resolve) => { finish = () => resolve(finalState); });
    const session = {
      runId: randomUUID(),
      state: { ...finalState, status: "running" as const, current_node_id: "product" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "node_started", node_id: "product", attempt: 1, activation: 1, ts: "2026-08-08T00:00:00.000Z", seq: 1 };
          yield { type: "transition", from: "product", to: "dev", reason: "success", activation: 1, ts: "2026-08-08T00:00:01.000Z", seq: 2 };
          await result;
        }
      },
      result,
      permissions: { resolve() {}, resolveAll() {}, hasPending() { return false; } },
      interrupt: async () => { finish(); },
      resumeWithUserInput: async () => {},
      continueWithInput: async () => {},
      dispatchToNode: async () => {},
      finalize: async () => {},
      subscribeState: () => () => {},
      waitForBoundary: async () => finalState
    };
    const engine = { async startInteractive() { return session; } };
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={testBusProviderFactory("product")}
        sessionStore={new SessionStore(join(cwd, "sessions"))}
      />
    );

    output.stdin.write("start work");
    await settle();
    output.stdin.write("\r");
    await waitForFrame(output, /流程流转：product -> dev/);

    const lines = (output.lastFrame() ?? "").split("\n");
    const busLine = lines.find((line) => line.startsWith("bus "));
    const cardBottomLine = lines.find((line) => line.includes("└"));
    assert.ok(busLine);
    assert.ok(cardBottomLine);
    const productStart = cardBottomLine.indexOf("└");
    const productEnd = cardBottomLine.indexOf("┘", productStart);
    assert.equal(busLine.indexOf("┐"), productStart + Math.floor((productEnd - productStart + 1) / 2));

    finish();
    output.unmount();
    output.cleanup();
  });
});

async function waitForFrame(output: { lastFrame(): string | undefined }, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (pattern.test(output.lastFrame() ?? "")) return;
    await settle();
  }
  assert.fail(`Timed out waiting for ${pattern}`);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

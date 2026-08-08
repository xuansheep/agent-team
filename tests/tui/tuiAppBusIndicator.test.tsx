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
      type: "openai-compatible" as const,
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

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import instances from "../../src/ink/instances.js";
import { charInCellAt, type Screen } from "../../src/ink/screen.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { renderSync } from "../../src/tui/ink.js";
import { testBusProviderFactory, testDispatcher } from "../helpers/projectConfig.js";

const config: AgentTeamConfig = {
  providers: {
    default: {
      type: "openai-compatible",
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
      nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" }],
      edges: []
    }
  }
};

class FakeStdout extends PassThrough {
  isTTY = false;
  columns = 80;
  rows = 24;

  constructor() {
    super();
    this.on("data", () => undefined);
  }
}

class FakeTtyStdin extends Readable {
  isTTY = true;
  isRaw = false;

  _read(): void {}

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  send(value: string): void {
    this.push(value);
    this.emit("readable");
  }
}

describe("TuiApp interrupt confirmation with local Ink", () => {
  it("keeps the run after one Enter on Keep running", async () => {
    const fixture = await activeRunFixture("keep-enter");
    try {
      await fixture.send("\u0003");
      assert.match(fixture.screen(), /Stop current run\?/);

      await fixture.send("\u001b[B");
      assert.match(fixture.screen(), /> 2\. Keep running/);

      await fixture.send("\r");
      assert.doesNotMatch(fixture.screen(), /Stop current run\?/);
      assert.equal(fixture.interrupted(), 0);
      assert.equal(fixture.exited(), 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the run after one numeric selection or one Escape", async () => {
    const numeric = await activeRunFixture("keep-numeric");
    try {
      await numeric.send("\u0003");
      await numeric.send("2");
      assert.doesNotMatch(numeric.screen(), /Stop current run\?/);
      assert.equal(numeric.interrupted(), 0);
      assert.equal(numeric.exited(), 0);
    } finally {
      numeric.cleanup();
    }

    const escape = await activeRunFixture("keep-escape");
    try {
      await escape.send("\u0003");
      await escape.send("\u001b", 100);
      assert.doesNotMatch(escape.screen(), /Stop current run\?/);
      assert.equal(escape.interrupted(), 0);
      assert.equal(escape.exited(), 0);
    } finally {
      escape.cleanup();
    }
  });

  it("interrupts and exits exactly once after the second Ctrl+C", async () => {
    const fixture = await activeRunFixture("interrupt-twice");
    try {
      await fixture.send("\u0003");
      await fixture.send("\u0003");
      await waitFor(() => fixture.interrupted() === 1 && fixture.exited() === 1);
      assert.equal(fixture.interrupted(), 1);
      assert.equal(fixture.exited(), 1);
    } finally {
      fixture.cleanup();
    }
  });

  it("interrupts active work exactly once on Escape without exiting", async () => {
    const fixture = await activeRunFixture("interrupt-escape");
    try {
      await fixture.send("\u001b", 100);
      await waitFor(() => fixture.interrupted() === 1);
      assert.equal(fixture.interrupted(), 1);
      assert.equal(fixture.exited(), 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("confirms and aborts work while the execution bus is still routing", async () => {
    let routingRequest: ModelRequest | undefined;
    let workflowStarts = 0;
    let exited = 0;
    const provider: ModelProvider = {
      generate: (request) => new Promise((_resolve, reject) => {
        routingRequest = request;
        const abort = () => reject(request.signal?.reason ?? new Error("routing aborted"));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      })
    };
    const fixture = renderFixture({
      name: "routing",
      engine: {
        async startInteractive() {
          workflowStarts += 1;
          return runningSession("routing-workflow", () => undefined);
        }
      },
      providerFactory: () => provider,
      onExit: () => {
        exited += 1;
      }
    });

    try {
      await sendLine(fixture.stdin, "route this request");
      await waitFor(() => Boolean(routingRequest));

      await send(fixture.stdin, "\u0003");
      assert.match(fixture.screen(), /Stop current run\?/);
      assert.equal(exited, 0);

      await send(fixture.stdin, "\r");
      await waitFor(() => routingRequest?.signal?.aborted === true && exited === 1);
      assert.equal(workflowStarts, 0);
      assert.equal(exited, 1);
    } finally {
      fixture.cleanup();
    }
  });

  it("denies a permission exactly once when Escape bubbles to the active choice", async () => {
    const resolved: Array<[string, "allow_once" | "deny_once"]> = [];
    const fixture = renderFixture({
      name: "permission-escape",
      engine: {
        async startInteractive() {
          return runningSession("run-permission-escape", () => undefined, {
            events: [{
              type: "permission_requested",
              request_id: "perm-1",
              node_id: "dev",
              attempt: 1,
              tool_call_id: "tool-1",
              tool: "Shell",
              input: { command: "verify" },
              specifier: "verify",
              ts: "2026-08-09T00:00:00.000Z",
              seq: 1
            }],
            resolvePermission: (requestId, decision) => resolved.push([requestId, decision])
          });
        }
      },
      providerFactory: testBusProviderFactory("dev"),
      onExit: () => undefined
    });

    try {
      await sendLine(fixture.stdin, "needs permission");
      await waitFor(() => fixture.screen().includes("Permission required"));
      await send(fixture.stdin, "\u001b", 100);
      await waitFor(() => resolved.length === 1);
      assert.deepEqual(resolved, [["perm-1", "deny_once"]]);
    } finally {
      fixture.cleanup();
    }
  });
});

async function activeRunFixture(name: string) {
  let interrupted = 0;
  let exited = 0;
  const runId = `run-${name}`;
  const fixture = renderFixture({
    name,
    engine: {
      async startInteractive() {
        return runningSession(runId, () => {
          interrupted += 1;
        });
      }
    },
    providerFactory: testBusProviderFactory("dev"),
    onExit: () => {
      exited += 1;
    }
  });
  await sendLine(fixture.stdin, "start work");
  await waitFor(() => fixture.screen().includes(runId));
  await new Promise((resolve) => setTimeout(resolve, 250));
  return {
    ...fixture,
    send: (value: string, delayMs?: number) => send(fixture.stdin, value, delayMs),
    interrupted: () => interrupted,
    exited: () => exited
  };
}

function renderFixture(input: {
  name: string;
  engine: { startInteractive(...args: never[]): Promise<unknown> };
  providerFactory: (providerId: string) => ModelProvider;
  onExit: () => void;
}) {
  const stdin = new FakeTtyStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  const instance = renderSync(
    <TuiApp
      cwd={join(process.cwd(), ".tmp", "tui-interrupt", `${input.name}-${randomUUID()}`)}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={input.engine as never}
      providerFactory={input.providerFactory}
      onExit={input.onExit}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false
    }
  );
  return {
    stdin,
    screen: () => currentScreenText(stdout),
    cleanup: () => {
      instance.unmount();
      instance.cleanup();
    }
  };
}

function runningSession(runId: string, interrupt: () => void, options: {
  events?: unknown[];
  resolvePermission?: (requestId: string, decision: "allow_once" | "deny_once") => void;
} = {}) {
  const state = {
    status: "running" as const,
    workflow_id: "delivery",
    current_node_id: "dev",
    attempts: [],
    handoff: undefined
  };
  return {
    sessionId: runId,
    runId,
    state,
    events: (async function* () {
      for (const event of options.events ?? []) yield event;
      await new Promise<void>(() => undefined);
    })(),
    permissions: {
      resolve: options.resolvePermission ?? (() => undefined),
      resolveAll: () => undefined,
      hasPending: () => false
    },
    interrupt: async () => interrupt(),
    resumeWithUserInput: async () => undefined,
    continueWithInput: async () => undefined,
    dispatchToNode: async () => undefined,
    finalize: async () => undefined,
    subscribeState: () => () => undefined,
    waitForBoundary: async () => state,
    result: new Promise<never>(() => undefined)
  };
}

function currentScreenText(stdout: FakeStdout): string {
  const screen = (instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen;
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => charInCellAt(screen, x, y) ?? " ").join("").trimEnd()
  ).join("\n");
}

async function sendLine(stdin: FakeTtyStdin, text: string): Promise<void> {
  for (const character of text) await send(stdin, character, 5);
  await send(stdin, "\r");
}

async function send(stdin: FakeTtyStdin, value: string, delayMs = 30): Promise<void> {
  stdin.send(value);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for TUI state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

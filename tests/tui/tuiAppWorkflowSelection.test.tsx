import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { renderSync } from "../../src/tui/ink.js";
import instances from "../../src/ink/instances.js";
import { charInCellAt, type Screen } from "../../src/ink/screen.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { testBusProviderFactory, testDispatcher } from "../helpers/projectConfig.js";

describe("TUI workflow selection guide", () => {
  it("previews workflows in list order and enters the conversation after confirmation", async () => {
    const output = render(
      <TuiApp
        cwd={process.cwd()}
        config={workflowConfig()}
        workflows={["alpha", "delivery"]}
      />
    );

    await settle();
    const initialFrame = output.lastFrame() ?? "";
    assert.match(initialFrame, /alpha-node/);
    assert.doesNotMatch(initialFrame, /delivery-node/);
    assert.match(initialFrame, /Delivery path/);
    assert.match(initialFrame, /Create new workflow/);
    assert.match(initialFrame, /Coming soon/);
    assert.doesNotMatch(initialFrame, /No description/);
    assert.doesNotMatch(initialFrame, /bottom interaction area/);

    output.stdin.write("\u001b[B");
    await settle();
    const deliveryPreview = output.lastFrame() ?? "";
    assert.match(deliveryPreview, /delivery-node/);
    assert.doesNotMatch(deliveryPreview, /alpha-node/);

    output.stdin.write("\r");
    await settle();
    const conversationFrame = output.lastFrame() ?? "";
    assert.match(conversationFrame, /workflow delivery/);
    assert.doesNotMatch(conversationFrame, /Select workflow/);
    assert.doesNotMatch(conversationFrame, /Create new workflow/);

    output.unmount();
  });

  it("keeps the create workflow placeholder disabled and preserves the last valid preview", async () => {
    const output = render(
      <TuiApp
        cwd={process.cwd()}
        config={workflowConfig()}
        workflows={["alpha", "delivery"]}
      />
    );

    await settle();
    output.stdin.write("\u001b[B");
    await settle();
    output.stdin.write("\u001b[B");
    await settle();

    const placeholderFrame = output.lastFrame() ?? "";
    assert.match(placeholderFrame, /Create new workflow/);
    assert.match(placeholderFrame, /delivery-node/);

    output.stdin.write("\r");
    await settle();
    const afterEnter = output.lastFrame() ?? "";
    assert.match(afterEnter, /Select workflow/);
    assert.match(afterEnter, /workflow unselected/);
    assert.match(afterEnter, /delivery-node/);

    output.unmount();
  });

  it("pins the statusline to the terminal bottom row during input and menus", async () => {
    await withTerminalSize(24, 80, async () => {
      const output = render(
        <TuiApp
          cwd={process.cwd()}
          config={workflowConfig()}
          workflows={["alpha", "delivery"]}
          workflowId="delivery"
        />
      );

      try {
        await settle();
        const frames = [output.lastFrame() ?? ""];
        output.stdin.write("/permissions");
        output.stdin.write("\r");
        await settle();
        frames.push(output.lastFrame() ?? "");

        assert.match(frames[0]!, /> Type a request or \/help/);
        assert.match(frames[1]!, /Default execution mode/);
        for (const frame of frames) {
          const lines = frame.split("\n");
          assert.equal(lines.length, 24);
          assert.match(lines.at(-1) ?? "", /^Ready \| default \|/);
        }
      } finally {
        output.unmount();
        output.cleanup();
      }
    });
  });

  it("bottom-aligns the complete statusline when it wraps in a narrow terminal", async () => {
    await withTerminalSize(24, 30, async () => {
      const cwd = join(process.cwd(), "a-very-long-project-directory");
      const tree = (
        <TuiApp
          cwd={cwd}
          config={workflowConfig()}
          workflows={["alpha", "delivery"]}
          workflowId="delivery"
          settings={{ statusLine: ["current-dir"] }}
        />
      );
      const output = render(tree);

      try {
        Object.defineProperty(output.stdout, "columns", { value: 30, configurable: true });
        output.rerender(tree);
        await settle();

        const lines = (output.lastFrame() ?? "").split("\n");
        assert.equal(lines.length, 24);
        assert.equal(lines.slice(-2).join(""), cwd);
        assert.equal(lines.at(-3), "");
        assert.match(lines.at(-4) ?? "", /> Type a request or \/help/);
      } finally {
        output.unmount();
        output.cleanup();
      }
    });
  });

  it("restores the local Ink input gap after closing the statusline menu", async () => {
    await withTerminalSize(24, 80, async () => {
      const stdin = new LocalFakeStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
      const stdout = new LocalFakeStdout() as unknown as NodeJS.WriteStream;
      const output = renderSync(
        <TuiApp cwd={process.cwd()} config={workflowConfig()} workflows={["delivery"]} workflowId="delivery" />,
        { stdin, stdout, stderr: new LocalFakeStdout() as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false }
      );

      try {
        await settle();
        const initial = localScreenLines(stdout);
        assert.match(initial[21] ?? "", /> Type a request or \/help/);
        assert.equal(initial[22], "");
        assert.match(initial[23] ?? "", /^Ready \| default \|/);

        await sendLocalKeys(stdin, [...Array.from("/statusline"), "\r"]);
        assert.match(localScreenLines(stdout).join("\n"), /Left\/right to reorder enabled items/);
        stdin.send("\u001b");
        await settle();
        await settle();

        const closed = localScreenLines(stdout);
        assert.match(closed[21] ?? "", /> Type a request or \/help/);
        assert.equal(closed[22], "");
        assert.match(closed[23] ?? "", /^Ready \| default \|/);
        assert.doesNotMatch(closed.slice(9, 21).join("\n"), /[│█]/);
      } finally {
        output.unmount();
        output.cleanup();
      }
    });
  });

  it("keeps the local Ink input gap when a paused run wraps the statusline", async () => {
    await withTerminalSize(24, 80, async () => {
      const runId = "550e8400-e29b-41d4-a716-446655440000";
      const pausedState = { status: "paused", workflow_id: "delivery", current_node_id: "delivery-node", attempts: [], questions: [] } as const;
      let finish!: () => void;
      let started = false;
      const result = new Promise<typeof pausedState>((resolve) => { finish = () => resolve(pausedState); });
      const session = {
        runId,
        state: { ...pausedState, status: "running" },
        events: { async *[Symbol.asyncIterator]() { await result; } },
        result,
        permissions: { resolve() {}, resolveAll() {}, hasPending() { return false; } },
        interrupt: async () => { finish(); },
        resumeWithUserInput: async () => {},
        continueWithInput: async () => {},
        dispatchToNode: async () => {},
        finalize: async () => {},
        subscribeState: () => () => {},
        waitForBoundary: async () => pausedState
      };
      const engine = { async startInteractive() { started = true; return session as never; } };
      const sessionStore = new SessionStore(join(process.cwd(), ".tmp", "workflow-selection", String(process.pid)));
      const stdin = new LocalFakeStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
      const stdout = new LocalFakeStdout() as unknown as NodeJS.WriteStream;
      const output = renderSync(
        <TuiApp
          cwd={process.cwd()}
          config={workflowConfig()}
          workflows={["delivery"]}
          workflowId="delivery"
          engine={engine as never}
          providerFactory={testBusProviderFactory("delivery-node")}
          sessionStore={sessionStore}
        />,
        { stdin, stdout, stderr: new LocalFakeStdout() as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false }
      );

      try {
        await settle();
        await sendLocalKeys(stdin, ["g", "o", "\r"]);
        for (let attempt = 0; attempt < 50 && !started; attempt += 1) await settle();
        assert.equal(started, true);
        finish();
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await settle();
          if (localScreenLines(stdout).some((line) => line.startsWith("Waiting |"))) break;
        }

        const lines = localScreenLines(stdout);
        const promptIndex = lines.findIndex((line) => line.startsWith("> "));
        const statusIndex = lines.findIndex((line) => line.startsWith("Waiting |"));
        assert.equal(statusIndex, promptIndex + 2);
        assert.equal(lines[promptIndex + 1], "");
        assert.equal(lines.at(-1), runId);
      } finally {
        output.unmount();
        output.cleanup();
      }
    });
  });

});

function workflowConfig(): AgentTeamConfig {
  return {
    providers: {
      default: {
        type: "openai-compatible",
        base_url: "https://api.example.test/v1",
        api_key: "test-key",
        default_model: "gpt-test",
        capabilities: {
          tool_calling: false,
          vision: false,
          streaming: false,
          json_schema_output: true
        }
      }
    },
    dispatcher: testDispatcher,
    roles: {
      dev: {
        description: "",
        system_prompt: "dev",
        requires: { tool_calling: false, vision: false }
      }
    },
    workflows: {
      alpha: {
        nodes: [{ id: "alpha-node", role: "dev", provider: "default", permission_mode: "default" }],
        edges: []
      },
      delivery: {
        description: "Delivery path",
        nodes: [{ id: "delivery-node", role: "dev", provider: "default", permission_mode: "default" }],
        edges: []
      }
    }
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function withTerminalSize(rows: number, columns: number, run: () => Promise<void>): Promise<void> {
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  try {
    await run();
  } finally {
    if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
    else Reflect.deleteProperty(process.stdout, "rows");
    if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
    else Reflect.deleteProperty(process.stdout, "columns");
  }
}


class LocalFakeStdout extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
}

class LocalFakeStdin extends Readable {
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

  send(input: string): void {
    this.push(input);
    this.emit("readable");
  }
}

function localScreenLines(stdout: NodeJS.WriteStream): string[] {
  const screen = (instances.get(stdout) as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen;
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => charInCellAt(screen, x, y) ?? " ").join("").trimEnd()
  );
}

async function sendLocalKeys(stdin: { send(input: string): void }, keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.send(key);
    await settle();
  }
}

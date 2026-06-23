import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";
import { PromptInputEvent } from "../../src/tui/components/PromptInput/types.js";
import { Box, Text, renderSync } from "../../src/tui/ink.js";

class FakeStdout extends PassThrough {
  isTTY: boolean;
  columns = 80;
  rows = 24;
  output = "";

  constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
    this.on("data", chunk => {
      this.output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
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

  send(input: string): void {
    this.push(input);
    this.emit("readable");
  }
}

describe("PromptInput with local Ink renderer", () => {
  it("submits text typed through the local readable stdin pipeline", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const events: PromptInputEvent[] = [];
    const instance = renderSync(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={(event) => events.push(event)}
      />,
      {
        stdin,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
        stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await settleEffects();
      await sendKeys(stdin, ["h", "e", "l", "l", "o", "\r"]);
      assert.deepEqual(events, [{ type: "submit", text: "hello" }]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("applies slash suggestions and control shortcuts through local useInput", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const events: PromptInputEvent[] = [];
    const instance = renderSync(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery", "audit"]}
        isLoading={false}
        onEvent={(event) => events.push(event)}
      />,
      {
        stdin,
        stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
        stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await settleEffects();
      await sendKeys(stdin, ["\u000f", "/", "r", "\t", "\r", "\r"]);
      assert.deepEqual(events, [
        { type: "toggle_log_detail" },
        { type: "command", name: "run", args: ["delivery"] },
      ]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("uses the native cursor without rendering a printable pipe or inverse block", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream & { output: string };
    const events: PromptInputEvent[] = [];
    const instance = renderSync(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={(event) => events.push(event)}
      />,
      {
        stdin,
        stdout,
        stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await settleEffects();
      const initialOutput = stdout.output;
      assert.match(stripAnsi(initialOutput), /INPUT > Type a request or \/help/);
      assert.doesNotMatch(stripAnsi(initialOutput), /INPUT > \|/);
      assert.doesNotMatch(initialOutput, /\u001b\[7m|\u001b\[27m/);

      await new Promise(resolve => setTimeout(resolve, 550));
      assert.equal(stdout.output, initialOutput);

      await sendKeys(stdin, ["a", "b", "c", "\u001b[D", "X", "\r"]);
      assert.deepEqual(events, [{ type: "submit", text: "abXc" }]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("handles submit-triggered async state updates without reconciler event priority crashes", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream & { output: string };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const instance = renderSync(
      <AsyncSubmitStateProbe />,
      {
        stdin,
        stdout,
        stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );

    try {
      await settleEffects();
      await sendKeys(stdin, ["h", "e", "l", "l", "o", "\r"]);
      await settleTimers();
      assert.deepEqual(unhandledRejections, []);
      assert.match(stdout.output, /submitted hello/);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      instance.unmount();
      instance.cleanup();
    }
  });
});

function settleEffects(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function settleTimers(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 25));
}

async function sendKeys(stdin: { send(input: string): void }, keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.send(key);
    await settleEffects();
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function AsyncSubmitStateProbe() {
  const [message, setMessage] = React.useState("ready");

  return (
    <Box flexDirection="column">
      <Text>{message}</Text>
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={(event) => {
          if (event.type !== "submit") return;
          void Promise.resolve().then(() => {
            setMessage(`submitted ${event.text}`);
          });
        }}
      />
    </Box>
  );
}

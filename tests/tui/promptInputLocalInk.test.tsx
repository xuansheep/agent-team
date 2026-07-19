import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";
import { PromptInputEvent } from "../../src/tui/components/PromptInput/types.js";
import type { PromptHistoryStore } from "../../src/storage/promptHistoryStore.js";
import { Box, Text, renderSync } from "../../src/tui/ink.js";
import instances from "../../src/ink/instances.js";
import { charInCellAt, type Screen } from "../../src/ink/screen.js";

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

function currentScreenText(stdout: NodeJS.WriteStream): string {
  const screen = (instances.get(stdout) as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen;
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => charInCellAt(screen, x, y) ?? " ").join("").trimEnd()
  ).join("\n");
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
      await sendKeys(stdin, ["/", "r", "\t", "\r", "\r"]);
      assert.deepEqual(events, [
        { type: "command", name: "resume", args: [] },
      ]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("scrolls slash command suggestions while navigating past the first page", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream & { output: string };
    const instance = renderSync(
      <Box height={10} flexDirection="column" justifyContent="flex-end">
        <PromptInput
          mode="input"
          workflowId="delivery"
          queued={[]}
          workflows={["delivery"]}
          isLoading={false}
          onEvent={() => undefined}
        />
      </Box>,
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
      stdin.send("/");
      await settleTimers();
      for (let index = 0; index < 6; index += 1) {
        stdin.send("\u001b[B");
        await settleTimers();
      }

      assert.match(stripAnsi(stdout.output), /> \/permissions/);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("removes slash suggestions without moving the prompt row", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
    const instance = renderSync(
      <Box height={10} flexDirection="column" justifyContent="flex-end">
        <PromptInput
          mode="input"
          workflowId="delivery"
          queued={[]}
          workflows={["delivery"]}
          isLoading={false}
          onEvent={() => undefined}
        />
        <Text>status</Text>
      </Box>,
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
      const initialLines = currentScreenText(stdout).split("\n");
      const initialPromptRow = initialLines.findIndex((line) => line.includes("Type a request or /help"));
      const initialStatusRow = initialLines.findIndex((line) => line.trim() === "status");

      stdin.send("/");
      await settleTimers();
      const suggestedLines = currentScreenText(stdout).split("\n");
      assert.match(suggestedLines.join("\n"), /Show help/);
      assert.equal(suggestedLines.findIndex((line) => line.trim() === "> /"), initialPromptRow);
      assert.equal(suggestedLines.findIndex((line) => line.trim() === "status"), initialStatusRow);

      stdin.send("\u007f");
      await settleTimers();
      const clearedScreen = currentScreenText(stdout);
      const clearedLines = clearedScreen.split("\n");
      assert.doesNotMatch(clearedScreen, /Show help/);
      assert.equal(clearedLines.findIndex((line) => line.includes("Type a request or /help")), initialPromptRow);
      assert.equal(clearedLines.findIndex((line) => line.trim() === "status"), initialStatusRow);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("does not insert ctrl shortcuts into the prompt buffer", async () => {
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
      await sendKeys(stdin, ["a", String.fromCharCode(15), "b", String.fromCharCode(13)]);
      assert.deepEqual(events, [{ type: "submit", text: "ab" }]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("does not insert Command+C into the prompt buffer", async () => {
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
      await sendKeys(stdin, ["a", "\u001b[99;9u", "\r"]);
      assert.deepEqual(events, [{ type: "submit", text: "a" }]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("recalls submitted prompt history with up and down arrows", async () => {
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
      await sendKeys(stdin, ["f", "i", "r", "s", "t", "\r"]);
      await sendKeys(stdin, ["s", "e", "c", "o", "n", "d", "\r"]);
      await settleTimers();

      stdin.send("\u001b[A");
      await settleTimers();
      assert.match(stripAnsi(stdout.output), /> second/);

      stdin.send("\u001b[A");
      await settleTimers();
      assert.match(stripAnsi(stdout.output), /> first/);

      stdin.send("\u001b[B");
      await settleTimers();
      assert.match(stripAnsi(stdout.output), /> second/);

      stdin.send("\u001b[B");
      await settleTimers();
      assert.match(stripAnsi(stdout.output), /> Type a request or \/help/);
      assert.deepEqual(events, [
        { type: "submit", text: "first" },
        { type: "submit", text: "second" }
      ]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("keeps navigating history when the recalled entry is a slash command", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
    const events: PromptInputEvent[] = [];
    const historyStore: PromptHistoryStore = {
      path: "history.jsonl",
      project: "project",
      sessionId: "session",
      entries: ["plain prompt", "/help"],
      add: () => undefined,
      flush: async () => undefined
    };
    const instance = renderSync(
      <Box height={10} flexDirection="column" justifyContent="flex-end">
        <PromptInput
          mode="input"
          workflowId="delivery"
          queued={[]}
          workflows={["delivery"]}
          isLoading={false}
          historyStore={historyStore}
          onEvent={(event) => events.push(event)}
        />
      </Box>,
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
      await sendKeys(stdin, ["d", "r", "a", "f", "t"]);
      stdin.send("\u001b[A");
      await settleTimers();
      const recalledSlashScreen = currentScreenText(stdout);
      assert.match(recalledSlashScreen, /> \/help/);
      assert.doesNotMatch(recalledSlashScreen, /Show help/);

      await sendKeys(stdin, ["\u001b[A", "\u001b[B", "\u001b[B"]);
      await sendKeys(stdin, ["\u001b[A", "\u001b[A", "\r"]);

      assert.deepEqual(events, [{ type: "submit", text: "plain prompt" }]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("loads persisted history supplied by the current project store", async () => {
    const stdin = new FakeTtyStdin() as unknown as NodeJS.ReadStream & { send(input: string): void };
    const events: PromptInputEvent[] = [];
    const recorded: string[] = [];
    const historyStore: PromptHistoryStore = {
      path: "history.jsonl",
      project: "project",
      sessionId: "session",
      entries: ["persisted prompt"],
      add: (value) => recorded.push(value),
      flush: async () => undefined
    };
    const instance = renderSync(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        historyStore={historyStore}
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
      await sendKeys(stdin, ["\u001b[A", "\r"]);

      assert.deepEqual(events, [{ type: "submit", text: "persisted prompt" }]);
      assert.deepEqual(recorded, ["persisted prompt"]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("uses Shift+Enter and Ctrl+Enter for newlines while Alt+Enter is a no-op", async () => {
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
      await sendKeys(stdin, [
        "a",
        "\u001b[13;2u",
        "b",
        "\u001b[13;5u",
        "c",
        "\u001b[13;3u",
        "d",
        "\r"
      ]);

      assert.deepEqual(events, [{ type: "submit", text: "a\nb\ncd" }]);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it("moves vertically inside multiline input before consulting history", async () => {
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
      await sendKeys(stdin, [
        "a",
        "b",
        "c",
        "\u001b[13;2u",
        "x",
        "\u001b[A",
        "X",
        "\u001b[B",
        "Y",
        "\r"
      ]);

      assert.deepEqual(events, [{ type: "submit", text: "aXbc\nxY" }]);
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
      assert.match(stripAnsi(initialOutput), /> Type a request or \/help/);
      assert.doesNotMatch(stripAnsi(initialOutput), /> \|/);
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
  return new Promise(resolve => setTimeout(resolve, 10));
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

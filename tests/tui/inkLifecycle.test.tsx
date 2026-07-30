import { useLayoutEffect } from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { PassThrough } from "node:stream";
import Ink from "../../src/ink/ink.js";
import { Text, renderSync } from "../../src/tui/ink.js";
import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";
import instances from "../../src/ink/instances.js";
import { cellAt, type Screen, type StylePool } from "../../src/ink/screen.js";

class FakeStdout extends PassThrough {
  isTTY = false;
  columns = 80;
  rows = 24;
}

class FakeStdin extends PassThrough {
  isTTY = false;
}

function ThrowOnMount() {
  useLayoutEffect(() => {
    throw new Error("boom-before-wait");
  }, []);

  return <Text>boom</Text>;
}

describe("local Ink lifecycle", () => {
  it("rejects waitUntilExit when the app already unmounted with an error", async () => {
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
    const stderr = new FakeStdout() as unknown as NodeJS.WriteStream;
    const stdin = new FakeStdin() as unknown as NodeJS.ReadStream;
    const restoreConsoleError = silenceConsoleError();

    let instance: ReturnType<typeof renderSync> | undefined;

    try {
      instance = renderSync(<ThrowOnMount />, {
        stdout,
        stderr,
        stdin,
        patchConsole: false,
        exitOnCtrlC: false,
      });

      await assertRejectsWithin(
        instance.waitUntilExit(),
        /boom-before-wait/,
        50,
      );
    } finally {
      restoreConsoleError();
      instance?.cleanup();
    }
  });

  it("keeps dim styles on every physical line of multiline text", async () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 1;
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
    const instance = renderSync(<Text dimColor>{"first\nsecond\nthird"}</Text>, {
      stdout,
      stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      const ink = instances.get(stdout) as unknown as { frontFrame: { screen: Screen }; stylePool: StylePool };
      for (const [row, expected] of ["first", "second", "third"].entries()) {
        const cell = cellAt(ink.frontFrame.screen, 0, row);
        assert.equal(cell?.char, expected[0]);
        assert.ok(
          cell && ink.stylePool.get(cell.styleId).some(style => style.code === "\u001b[2m"),
          "row " + row + " should retain the dim style"
        );
      }
    } finally {
      instance.unmount();
      instance.cleanup();
      chalk.level = previousChalkLevel;
    }
  });

  it("dims nested tool titles and summaries under response arrows", async () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 1;
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
    const instance = renderSync(
      <RunLogPanel detailMode={false} items={[
        { id: "assistant", kind: "assistant", nodeId: "developer", attempt: 1, text: "Writing artifact." },
        { id: "tool", kind: "tool", nodeId: "developer", attempt: 1, parentLogId: "assistant", toolCallId: "tool", tool: "ArtifactWrite", status: "completed", text: "ArtifactWrite", summary: "content: # UI design specification v1.0", detailText: "" }
      ]} />,
      { stdout, stderr: new FakeStdout() as unknown as NodeJS.WriteStream, stdin: new FakeStdin() as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false }
    );

    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      const ink = instances.get(stdout) as unknown as { frontFrame: { screen: Screen }; stylePool: StylePool };
      const screen = ink.frontFrame.screen;
      const expected = "Ran ArtifactWrite content: # UI design specification v1.0";
      const lines = Array.from({ length: screen.height }, (_, row) =>
        Array.from({ length: screen.width }, (_, column) => cellAt(screen, column, row)?.char ?? " ").join("").trimEnd()
      );
      const row = lines.findIndex(line => line.includes(expected));
      assert.notEqual(row, -1);
      for (let column = lines[row]!.indexOf(expected); column < lines[row]!.length; column += 1) {
        const cell = cellAt(screen, column, row);
        if (!cell || cell.char === " ") continue;
        const styles = ink.stylePool.get(cell.styleId);
        assert.ok(styles.some(style => style.code === "\u001b[2m"));
        assert.equal(styles.some(style => style.code === "\u001b[1m"), false);
      }
    } finally {
      instance.unmount();
      instance.cleanup();
      chalk.level = previousChalkLevel;
    }
  });

  it("pins the event loop while waitUntilExit is pending", async () => {
    const ink = new Ink({
      stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      stderr: new FakeStdout() as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    const internals = ink as unknown as { waitUntilExitKeepAlive?: unknown };

    const waiting = ink.waitUntilExit();
    assert.ok(internals.waitUntilExitKeepAlive);
    ink.unmount();
    await waiting;
    assert.equal(internals.waitUntilExitKeepAlive, undefined);
  });
});

async function assertRejectsWithin(
  promise: Promise<void>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const result = await Promise.race([
    promise.then(
      () => ({ type: "resolved" as const }),
      error => ({ type: "rejected" as const, error }),
    ),
    delay(timeoutMs).then(() => ({ type: "timeout" as const })),
  ]);

  if (result.type === "timeout") {
    assert.fail(`waitUntilExit did not settle within ${timeoutMs}ms`);
  }

  if (result.type === "resolved") {
    assert.fail("waitUntilExit resolved instead of rejecting");
  }

  assert.match(String(result.error?.message ?? result.error), pattern);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
}

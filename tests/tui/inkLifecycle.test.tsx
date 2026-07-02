import { useLayoutEffect } from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import Ink from "../../src/ink/ink.js";
import { Text, renderSync } from "../../src/tui/ink.js";

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

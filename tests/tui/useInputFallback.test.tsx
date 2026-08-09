import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Text, useStdin as useFallbackStdin } from "ink";
import { render } from "ink-testing-library";
import useInput from "../../src/ink/hooks/use-input.js";
import { ensureRefableStdin } from "../../src/tui/inkStdin.js";

describe("useInput fallback propagation", () => {
  it("delivers a delayed Escape to only the listener that consumes it", async () => {
    const events: string[] = [];
    const output = render(<FallbackProbe events={events} />);
    try {
      output.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(events, ["first"]);
    } finally {
      output.unmount();
      output.cleanup();
    }
  });
});

function FallbackProbe({ events }: { events: string[] }) {
  const { stdin } = useFallbackStdin();
  ensureRefableStdin(stdin);
  useInput((_input, key, event) => {
    if (!key.escape) return;
    events.push("first");
    event.stopImmediatePropagation();
  });
  useInput((_input, key) => {
    if (key.escape) events.push("second");
  });
  return <Text>probe</Text>;
}

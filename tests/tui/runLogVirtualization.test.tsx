import React, { createRef } from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";
import { ScrollBox, renderSync, type ScrollBoxHandle } from "../../src/tui/ink.js";
import type { TuiLogMessage } from "../../src/tui/logTypes.js";
import instances from "../../src/ink/instances.js";
import { charInCellAt, type Screen } from "../../src/ink/screen.js";

class FakeStdout extends PassThrough {
  isTTY = false;
  columns = 80;
  rows = 24;
}

type DomNode = { childNodes?: DomNode[] };

describe("RunLogPanel virtualization", () => {
  it("keeps mounted nodes bounded while preserving tail updates and history access", async () => {
    const stdout = new FakeStdout() as unknown as NodeJS.WriteStream;
    const stderr = new FakeStdout() as unknown as NodeJS.WriteStream;
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const scrollRef = createRef<ScrollBoxHandle>();
    const items = Array.from({ length: 5000 }, (_, index): TuiLogMessage => ({
      id: `log-${index}`,
      kind: "status",
      text: `log-${index}`
    }));

    const view = (logs: TuiLogMessage[]) => (
      <ScrollBox ref={scrollRef} height={12} flexDirection="column" stickyScroll>
        <RunLogPanel
          items={logs}
          detailMode={false}
          scrollRef={scrollRef}
          columns={80}
        />
      </ScrollBox>
    );

    const instance = renderSync(view(items), {
      stdout,
      stderr,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false
    });

    try {
      await settleFrames();
      assert.match(currentScreenText(stdout), /log-4999/);
      assert.ok(domNodeCount(stdout) < 1500);

      const updated = [...items];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        text: "TAIL_UPDATE_SENTINEL"
      };
      instance.rerender(view(updated));
      await settleFrames();
      assert.match(currentScreenText(stdout), /TAIL_UPDATE_SENTINEL/);
      assert.ok(domNodeCount(stdout) < 1500);

      scrollRef.current?.scrollTo(0);
      await settleFrames();
      assert.match(currentScreenText(stdout), /log-0/);
      assert.ok(domNodeCount(stdout) < 1500);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });
});

function domNodeCount(stdout: NodeJS.WriteStream): number {
  const rootNode = (instances.get(stdout) as unknown as { rootNode: DomNode }).rootNode;
  const visit = (node: DomNode): number =>
    1 + (node.childNodes ?? []).reduce((total, child) => total + visit(child), 0);
  return visit(rootNode);
}

function currentScreenText(stdout: NodeJS.WriteStream): string {
  const screen = (instances.get(stdout) as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen;
  return Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => charInCellAt(screen, x, y) ?? " ").join("").trimEnd()
  ).join("\n");
}

async function settleFrames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

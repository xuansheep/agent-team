import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { Box } from "../../src/tui/ink.js";
import { InteractionArea, type InteractionChoice } from "../../src/tui/components/InteractionArea.js";

describe("InteractionArea choice placement", () => {
  it("keeps bottom choices compact and expands half-screen choices with terminal height", () => {
    withStdoutRows(40, () => {
      const bottom = render(
        <Box height={30} flexDirection="column">
          <InteractionArea {...interactionProps()} choice={choice()} />
        </Box>
      );
      const halfScreen = render(
        <Box height={30} flexDirection="column">
          <InteractionArea {...interactionProps()} choice={{ ...choice(), placement: "half-screen" }} />
        </Box>
      );

      const bottomFrame = bottom.lastFrame() ?? "";
      const halfScreenFrame = halfScreen.lastFrame() ?? "";
      assert.match(bottomFrame, /Option 07/);
      assert.doesNotMatch(bottomFrame, /Option 08/);
      assert.match(halfScreenFrame, /Option 12/);
      assert.ok(borderContentRows(halfScreenFrame) > borderContentRows(bottomFrame));

      bottom.unmount();
      halfScreen.unmount();
    });
  });

  it("honors an explicit visible option count in half-screen mode", () => {
    withStdoutRows(40, () => {
      const output = render(
        <Box height={30} flexDirection="column">
          <InteractionArea
            {...interactionProps()}
            choice={{ ...choice(), placement: "half-screen", visibleOptionCount: 3 }}
          />
        </Box>
      );

      const frame = output.lastFrame() ?? "";
      assert.match(frame, /Option 03/);
      assert.doesNotMatch(frame, /Option 04/);

      output.unmount();
    });
  });
});

function interactionProps() {
  return {
    mode: "input" as const,
    workflowId: "delivery",
    queued: [],
    workflows: ["delivery"],
    isLoading: false,
    onPromptEvent: () => undefined
  };
}

function choice(): InteractionChoice {
  return {
    title: "Select an option",
    selectedValue: "option-01",
    options: Array.from({ length: 12 }, (_, index) => {
      const ordinal = String(index + 1).padStart(2, "0");
      return { label: `Option ${ordinal}`, value: `option-${ordinal}` };
    }),
    onSubmit: () => undefined
  };
}

function borderContentRows(frame: string): number {
  return frame.split("\n").filter((line) => line.includes("│")).length;
}

function withStdoutRows(rows: number, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "rows", descriptor);
    else Reflect.deleteProperty(process.stdout, "rows");
  }
}

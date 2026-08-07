import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { stringWidth } from "../../src/ink/stringWidth.js";
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

describe("InteractionArea activity status", () => {
  it("renders the Codex-style running row above the prompt", () => {
    withStdoutColumns(60, () => {
      const output = render(
        <InteractionArea
          {...interactionProps()}
          mode="running"
          activityStatus={{ kind: "running", elapsed: "12s" }}
        />
      );

      const lines = (output.lastFrame() ?? "").split("\n");
      const statusIndex = lines.findIndex((line) => line.includes("Working (12s • esc to interrupt)"));
      const promptIndex = lines.findIndex((line) => line.includes("> Type a request or /help"));
      assert.notEqual(statusIndex, -1);
      assert.match(lines[statusIndex] ?? "", /^[•◦] Working \(12s • esc to interrupt\) ─+$/);
      assert.equal(stringWidth(lines[statusIndex] ?? ""), 60);
      assert.equal(lines[statusIndex + 1]?.trim(), "");
      assert.equal(promptIndex, statusIndex + 2);

      output.unmount();
      output.cleanup();
    });
  });

  it("truncates wide status details while preserving the trailing divider", () => {
    withStdoutColumns(52, () => {
      const output = render(
        <InteractionArea
          {...interactionProps()}
          mode="running"
          activityStatus={{
            kind: "running",
            elapsed: "1m 02s",
            detail: "模型重连中，正在等待远端服务恢复并重新建立连接"
          }}
        />
      );

      const line = (output.lastFrame() ?? "").split("\n").find((item) => item.includes("Working")) ?? "";
      assert.equal(stringWidth(line), 52);
      assert.match(line, / · .*… ─{3,}$/);

      output.unmount();
      output.cleanup();
    });
  });

  it("keeps completed and warning status rows static with a divider", () => {
    withStdoutColumns(80, () => {
      const completed = render(
        <InteractionArea
          {...interactionProps()}
          activityStatus={{ kind: "completed", elapsed: "3m 05s" }}
        />
      );
      const warning = render(
        <InteractionArea
          {...interactionProps()}
          activityStatus={{ kind: "warning", text: "■ Conversation interrupted. Describe how to proceed." }}
        />
      );

      assert.match(completed.lastFrame() ?? "", /• Worked for 3m 05s ─+/);
      assert.match(warning.lastFrame() ?? "", /■ Conversation interrupted[.] Describe how to proceed[.] ─+/);

      completed.unmount();
      completed.cleanup();
      warning.unmount();
      warning.cleanup();
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

function withStdoutColumns(columns: number, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "columns", descriptor);
    else Reflect.deleteProperty(process.stdout, "columns");
  }
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

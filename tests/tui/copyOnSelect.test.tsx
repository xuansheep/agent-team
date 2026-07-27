import React from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "ink-testing-library";
import { useCopyOnSelect } from "../../src/ink/hooks/use-copy-on-select.js";
import { Text } from "../../src/tui/ink.js";

type FakeSelection = {
  selected: boolean;
  state: { isDragging: boolean };
  copies: number;
  copiedText: string;
  listeners: Set<() => void>;
  hasSelection: () => boolean;
  getState: () => { isDragging: boolean };
  subscribe: (listener: () => void) => () => void;
  copySelectionNoClear: () => string;
};

function createFakeSelection(copiedText = "selected text"): FakeSelection {
  const selection: FakeSelection = {
    selected: false,
    state: { isDragging: false },
    copies: 0,
    copiedText,
    listeners: new Set(),
    hasSelection: () => selection.selected,
    getState: () => selection.state,
    subscribe: (listener) => {
      selection.listeners.add(listener);
      return () => selection.listeners.delete(listener);
    },
    copySelectionNoClear: () => {
      selection.copies += 1;
      return selection.copiedText;
    },
  };
  return selection;
}

function notify(selection: FakeSelection): void {
  for (const listener of selection.listeners) listener();
}

function Probe({ selection, enabled }: { selection: FakeSelection; enabled: boolean }) {
  const copiedCharacterCount = useCopyOnSelect(selection as never, enabled);
  return <Text>{copiedCharacterCount === undefined ? "not copied" : `copied ${copiedCharacterCount} chars`}</Text>;
}

describe("copy on select", () => {
  it("copies each settled selection once and exposes its Unicode code-point count", async () => {
    const selection = createFakeSelection("A中😀\n");
    const output = render(<Probe selection={selection} enabled />);

    try {
      await settleEffects();
      selection.selected = true;
      selection.state.isDragging = true;
      notify(selection);
      await settleEffects();
      assert.equal(selection.copies, 0);
      assert.match(output.lastFrame() ?? "", /not copied/);

      selection.state.isDragging = false;
      notify(selection);
      await settleEffects();
      assert.equal(selection.copies, 1);
      assert.equal(selection.selected, true);
      assert.match(output.lastFrame() ?? "", /copied 4 chars/);

      notify(selection);
      assert.equal(selection.copies, 1);

      selection.selected = false;
      notify(selection);
      await settleEffects();
      assert.match(output.lastFrame() ?? "", /not copied/);

      selection.selected = true;
      selection.state.isDragging = true;
      notify(selection);
      selection.state.isDragging = false;
      notify(selection);
      await settleEffects();
      assert.equal(selection.copies, 2);
      assert.match(output.lastFrame() ?? "", /copied 4 chars/);
    } finally {
      output.unmount();
      output.cleanup();
    }
  });

  it("does not report copied content for whitespace-only selections", async () => {
    const selection = createFakeSelection(" \n");
    const output = render(<Probe selection={selection} enabled />);

    try {
      await settleEffects();
      selection.selected = true;
      notify(selection);
      await settleEffects();
      assert.equal(selection.copies, 1);
      assert.match(output.lastFrame() ?? "", /not copied/);
    } finally {
      output.unmount();
      output.cleanup();
    }
  });

  it("does not copy or report a selection when copyOnSelect is disabled", async () => {
    const selection = createFakeSelection();
    const output = render(<Probe selection={selection} enabled={false} />);

    try {
      await settleEffects();
      selection.selected = true;
      notify(selection);
      await settleEffects();
      assert.equal(selection.copies, 0);
      assert.equal(selection.selected, true);
      assert.match(output.lastFrame() ?? "", /not copied/);
    } finally {
      output.unmount();
      output.cleanup();
    }
  });
});

async function settleEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

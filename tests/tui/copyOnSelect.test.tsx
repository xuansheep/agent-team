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
  listeners: Set<() => void>;
  hasSelection: () => boolean;
  getState: () => { isDragging: boolean };
  subscribe: (listener: () => void) => () => void;
  copySelectionNoClear: () => string;
};

function createFakeSelection(): FakeSelection {
  const selection: FakeSelection = {
    selected: false,
    state: { isDragging: false },
    copies: 0,
    listeners: new Set(),
    hasSelection: () => selection.selected,
    getState: () => selection.state,
    subscribe: (listener) => {
      selection.listeners.add(listener);
      return () => selection.listeners.delete(listener);
    },
    copySelectionNoClear: () => {
      selection.copies += 1;
      return "selected text";
    },
  };
  return selection;
}

function notify(selection: FakeSelection): void {
  for (const listener of selection.listeners) listener();
}

function Probe({ selection, enabled }: { selection: FakeSelection; enabled: boolean }) {
  useCopyOnSelect(selection as never, enabled);
  return <Text>probe</Text>;
}

describe("copy on select", () => {
  it("copies each settled selection once without clearing it", async () => {
    const selection = createFakeSelection();
    const output = render(<Probe selection={selection} enabled />);

    try {
      await settleEffects();
      selection.selected = true;
      selection.state.isDragging = true;
      notify(selection);
      assert.equal(selection.copies, 0);

      selection.state.isDragging = false;
      notify(selection);
      assert.equal(selection.copies, 1);
      assert.equal(selection.selected, true);

      notify(selection);
      assert.equal(selection.copies, 1);

      selection.selected = false;
      notify(selection);
      selection.selected = true;
      selection.state.isDragging = true;
      notify(selection);
      selection.state.isDragging = false;
      notify(selection);
      assert.equal(selection.copies, 2);
      assert.equal(selection.selected, true);
    } finally {
      output.unmount();
      output.cleanup();
    }
  });

  it("does not copy when copyOnSelect is disabled", async () => {
    const selection = createFakeSelection();
    const output = render(<Probe selection={selection} enabled={false} />);

    try {
      await settleEffects();
      selection.selected = true;
      notify(selection);
      assert.equal(selection.copies, 0);
      assert.equal(selection.selected, true);
    } finally {
      output.unmount();
      output.cleanup();
    }
  });
});

async function settleEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

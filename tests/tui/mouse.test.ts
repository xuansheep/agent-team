import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSgrMouseEvent, scrollPaneByMouse } from "../../src/tui/mouse.js";

describe("TUI mouse handling", () => {
  it("parses SGR wheel events", () => {
    assert.deepEqual(parseSgrMouseEvent("\u001b[<64;12;5M"), { type: "wheel", direction: "up", x: 11, y: 4 });
    assert.deepEqual(parseSgrMouseEvent("\u001b[<65;12;5M"), { type: "wheel", direction: "down", x: 11, y: 4 });
    assert.deepEqual(parseSgrMouseEvent(Buffer.from("\u001b[<65;12;5M")), { type: "wheel", direction: "down", x: 11, y: 4 });
    assert.equal(parseSgrMouseEvent("plain"), undefined);
  });

  it("scrolls only the pane under the mouse", () => {
    const state = { log: 0, plan: 3 };
    const panes = [
      { id: "log" as const, top: 4, bottom: 12, maxOffset: 20 },
      { id: "plan" as const, top: 13, bottom: 18, maxOffset: 10 }
    ];

    assert.deepEqual(scrollPaneByMouse(state, panes, { type: "wheel", direction: "down", x: 1, y: 14 }), { log: 0, plan: 4 });
    assert.deepEqual(scrollPaneByMouse(state, panes, { type: "wheel", direction: "up", x: 1, y: 7 }), { log: 0, plan: 3 });
    assert.deepEqual(scrollPaneByMouse(state, panes, { type: "wheel", direction: "down", x: 1, y: 30 }), state);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActiveTurnInputChannel } from "../../src/runtime/activeTurnInput.js";

describe("ActiveTurnInputChannel", () => {
  it("accepts FIFO input only while the active turn is open", () => {
    const channel = new ActiveTurnInputChannel<string>();

    assert.deepEqual(channel.offer("before", "before-id"), { id: "before-id", disposition: "next_turn" });

    channel.open();
    assert.deepEqual(channel.offer("one", "one-id"), { id: "one-id", disposition: "active_turn" });
    assert.deepEqual(channel.offer("two", "two-id"), { id: "two-id", disposition: "active_turn" });
    assert.deepEqual(channel.drain(), [
      { id: "one-id", input: "one" },
      { id: "two-id", input: "two" }
    ]);

    channel.offer("deferred", "deferred-id");
    assert.deepEqual(channel.close(), [{ id: "deferred-id", input: "deferred" }]);
    assert.equal(channel.isOpen(), false);
    assert.deepEqual(channel.offer("after", "after-id"), { id: "after-id", disposition: "next_turn" });
  });
});

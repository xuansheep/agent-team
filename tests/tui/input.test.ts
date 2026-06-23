import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTerminalInputParser } from "../../src/tui/input/parser.js";

function parseChunks(chunks: string[]) {
  const parser = createTerminalInputParser();
  return chunks.flatMap((chunk) => parser.feed(chunk));
}

describe("TUI terminal input parser", () => {
  it("parses mouse reporting without leaking text fragments", () => {
    assert.deepEqual(parseChunks(["\u001b[<64;12;5M"]), [{ type: "key", input: "", key: { wheelUp: true } }]);
    assert.deepEqual(parseChunks(["\u001b[<65;12;5M\u001b[<0;4;2M"]), [
      { type: "key", input: "", key: { wheelDown: true } },
      { type: "mouse", action: "press", button: 0, x: 3, y: 1 }
    ]);
    assert.deepEqual(parseChunks(["\u001b", "[<64;12;5M"]), [{ type: "key", input: "", key: { wheelUp: true } }]);
    assert.deepEqual(parseChunks(["[<65;12;5M"]), [{ type: "key", input: "", key: { wheelDown: true } }]);
  });

  it("parses bracketed paste as a paste event", () => {
    assert.deepEqual(parseChunks(["\u001b[200~hello\n/world\u001b[201~"]), [{ type: "paste", text: "hello\n/world" }]);
  });

  it("keeps printable unicode input as text keys", () => {
    assert.deepEqual(parseChunks(["你好🙂"]), [{ type: "key", input: "你好🙂", key: {} }]);
  });
});

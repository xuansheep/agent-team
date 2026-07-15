import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeSseBlocks } from "../../src/providers/http.js";

describe("consumeSseBlocks", () => {
  it("dispatches CRLF-delimited events independently across chunk boundaries", async () => {
    const data: string[] = [];
    const stopped = await consumeSseBlocks(bodyFromChunks([
      "data: first\r",
      "\ndata: second\r\n\r",
      "\ndata: third\r\n",
      "\r",
      "\ndata: [DONE]\r\n\r\n",
      "data: ignored\r\n\r\n"
    ]), (value) => {
      data.push(value);
    });

    assert.equal(stopped, true);
    assert.deepEqual(data, ["first\nsecond", "third"]);
  });

  it("supports LF, CR, mixed line endings, and an unterminated final event", async () => {
    const data: string[] = [];
    const stopped = await consumeSseBlocks(bodyFromChunks([
      ": keepalive\ndata: first\ndata: second\n\n",
      "data: third\r\r",
      "data: fourth\r\n\n",
      "data: tail"
    ]), (value) => {
      data.push(value);
    });

    assert.equal(stopped, false);
    assert.deepEqual(data, ["first\nsecond", "third", "fourth", "tail"]);
  });
});

function bodyFromChunks(chunks: string[]): { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  return {
    getReader() {
      let index = 0;
      return {
        async read() {
          const value = encoded[index];
          index += 1;
          return value ? { done: false, value } : { done: true };
        }
      };
    }
  };
}

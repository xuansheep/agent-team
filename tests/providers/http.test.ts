import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeSseBlocks, providerStreamApiError } from "../../src/providers/http.js";

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

describe("providerStreamApiError", () => {
  it("does not retry stream authentication, permission, invalid-request, or context-limit errors", () => {
    const cases = [
      providerStreamApiError("auth", { status: 401, detail: "unauthorized" }),
      providerStreamApiError("permission", { marker: "permission_error", detail: "forbidden" }),
      providerStreamApiError("invalid", { marker: "invalid_request_error", detail: "bad request" }),
      providerStreamApiError("context", { marker: "request_too_large", detail: "input is too long" })
    ];

    assert.deepEqual(cases.map((error) => error.errorKind), ["auth", "permission", "invalid_request", "context_limit"]);
    assert.equal(cases.every((error) => error.retryable === false), true);
  });

  it("retries rate limits and service failures reported inside a stream", () => {
    const rateLimit = providerStreamApiError("limited", { status: 429, detail: "rate limited" });
    const overloaded = providerStreamApiError("overloaded", { marker: "overloaded_error", detail: "try again" });

    assert.equal(rateLimit.errorKind, "rate_limit");
    assert.equal(rateLimit.retryable, true);
    assert.equal(overloaded.errorKind, "server");
    assert.equal(overloaded.retryable, true);
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

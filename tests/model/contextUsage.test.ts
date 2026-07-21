import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextTokensFromUsage, estimateModelMessageTokens, estimateModelMessagesTokens } from "../../src/model/contextUsage.js";

describe("context usage", () => {
  it("uses the latest normalized input and output usage as the exact context baseline", () => {
    assert.equal(contextTokensFromUsage({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, totalTokens: 120 }), 120);
    assert.equal(contextTokensFromUsage({ cachedInputTokens: 40 }), undefined);
    assert.equal(contextTokensFromUsage(undefined), undefined);
  });

  it("estimates text, tool calls, and images added after the latest response", () => {
    const text = { role: "user" as const, content: "abcdefgh" };
    const tool = {
      role: "assistant" as const,
      content: "",
      tool_calls: [{ id: "call-1", name: "Read", input: { path: "a" } }]
    };
    const image = {
      role: "user" as const,
      content: [{ type: "image" as const, media_type: "image/png" as const, data: "ignored-base64" }]
    };

    assert.equal(estimateModelMessageTokens(text), 2);
    assert.equal(estimateModelMessageTokens(tool), Math.round(("Read".length + JSON.stringify({ path: "a" }).length) / 4));
    assert.equal(estimateModelMessageTokens(image), 2000);
    assert.equal(estimateModelMessagesTokens([text, image]), 2002);
  });
});

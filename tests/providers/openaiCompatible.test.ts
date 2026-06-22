import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toOpenAiMessages } from "../../src/providers/openaiCompatible.js";

describe("toOpenAiMessages", () => {
  it("keeps text and image content in one user message", () => {
    const messages = toOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Review this design" },
          { type: "image", media_type: "image/png", data: "abc" }
        ]
      }
    ]) as Array<{ content: unknown }>;

    assert.deepEqual(messages[0].content, [
      { type: "text", text: "Review this design" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
    ]);
  });
});

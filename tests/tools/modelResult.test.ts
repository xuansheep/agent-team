import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelToolResultContent, truncateModelVisibleText } from "../../src/tools/modelResult.js";

describe("model-visible tool result limits", () => {
  it("preserves both ends with the Codex middle-truncation marker", () => {
    const value = `HEAD-${"中".repeat(200)}-TAIL`;
    const truncated = truncateModelVisibleText(value, 160);

    assert.match(truncated, /^HEAD-/);
    assert.match(truncated, /-TAIL$/);
    assert.match(truncated, /chars truncated/);
    assert.equal(truncated.includes("�"), false);
  });

  it("applies one shared text budget across multipart tool output", () => {
    const content = modelToolResultContent([
      { type: "text", text: "a".repeat(100) },
      { type: "text", text: "b".repeat(100) },
      { type: "tool_reference", tool_name: "Search" }
    ], { byteLimit: 80 });

    assert.ok(Array.isArray(content));
    assert.equal(content.some((part) => part.type === "text" && part.text.includes("chars truncated")), true);
    assert.equal(content.some((part) => part.type === "text" && part.text === "[omitted 1 text items ...]"), true);
    assert.equal(content.some((part) => part.type === "tool_reference"), true);
  });
});

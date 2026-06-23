import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nodeResultJsonSchema, parseNodeResult } from "../../src/team/nodeResult.js";

describe("nodeResultJsonSchema", () => {
  it("requires every top-level property for strict structured output", () => {
    const properties = Object.keys(nodeResultJsonSchema.properties).sort();
    const required = [...nodeResultJsonSchema.required].sort();

    assert.deepEqual(required, properties);
  });

  it("defaults document to an empty string when omitted", () => {
    const result = parseNodeResult(JSON.stringify({ status: "success", summary: "done" }));

    assert.equal(result.document, "");
  });
});

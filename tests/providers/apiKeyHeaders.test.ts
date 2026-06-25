import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApiKeyHeaders } from "../../src/providers/http.js";

describe("buildApiKeyHeaders", () => {
  it("uses bearer authorization headers", () => {
    assert.deepEqual(buildApiKeyHeaders("test-key", "bearer"), {
      authorization: "Bearer test-key"
    });
  });

  it("uses x-api-key headers", () => {
    assert.deepEqual(buildApiKeyHeaders("test-key", "x-api-key"), {
      "x-api-key": "test-key"
    });
  });
});

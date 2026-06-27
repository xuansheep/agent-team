import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sdkPlanDecisionSchema, sdkQuerySchema } from "../../src/sdk/schemas.js";

describe("SDK schemas", () => {
  it("validates local query input without remote transport fields", () => {
    const parsed = sdkQuerySchema.parse({
      model: "test-model",
      cwd: process.cwd(),
      messages: [{ role: "user", content: "hello" }]
    });

    assert.equal(parsed.permissionMode, "default");
    assert.equal((parsed as Record<string, unknown>).remoteUrl, undefined);
  });

  it("validates plan decisions", () => {
    assert.equal(sdkPlanDecisionSchema.parse("continue"), "continue");
    assert.throws(() => sdkPlanDecisionSchema.parse("remote"));
  });
});

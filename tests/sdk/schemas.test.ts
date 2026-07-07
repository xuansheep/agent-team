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

  it("accepts only current SDK permission modes", () => {
    assert.equal(sdkQuerySchema.parse(baseQuery({ permissionMode: "default" })).permissionMode, "default");
    assert.equal(sdkQuerySchema.parse(baseQuery({ permissionMode: "fullAccess" })).permissionMode, "fullAccess");
    assert.equal(sdkQuerySchema.parse(baseQuery({ permissionMode: "plan" })).permissionMode, "plan");
    for (const permissionMode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
      assert.throws(() => sdkQuerySchema.parse(baseQuery({ permissionMode })), /Invalid enum value/);
    }
  });

  it("validates plan decisions", () => {
    assert.equal(sdkPlanDecisionSchema.parse("continue"), "continue");
    assert.throws(() => sdkPlanDecisionSchema.parse("remote"));
  });
});

function baseQuery(patch: Record<string, unknown> = {}) {
  return { model: "test-model", messages: [], cwd: process.cwd(), ...patch };
}

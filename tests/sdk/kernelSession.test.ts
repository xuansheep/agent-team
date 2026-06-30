import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalHeadlessSession } from "../../src/sdk/localSession.js";
import type { ModelProvider } from "../../src/providers/types.js";

function emptyProvider(): ModelProvider {
  return { generate: async () => ({ content: "done" }), stream: undefined } as unknown as ModelProvider;
}

describe("SDK KernelSession integration", () => {
  it("exposes kernel app state", () => {
    const session = new LocalHeadlessSession({
      sessionId: "sdk-s1",
      cwd: process.cwd(),
      provider: emptyProvider(),
      model: "test-model"
    });
    session.enterPlanMode({ request: "build" });
    const state = session.getAppState();

    assert.equal(state.status, "planning");
    assert.equal(state.planState?.mode, "planning");
  });
});

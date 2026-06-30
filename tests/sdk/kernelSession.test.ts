import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalHeadlessSession } from "../../src/sdk/localSession.js";
import type { ModelProvider } from "../../src/providers/types.js";

const provider: ModelProvider = { generate: async () => ({ content: "ok" }), stream: undefined } as unknown as ModelProvider;

describe("LocalHeadlessSession kernel state", () => {
  it("projects plan mode through kernel app state", () => {
    const session = new LocalHeadlessSession({ cwd: process.cwd(), provider, model: "test-model" });
    session.enterPlanMode({ request: "build" });

    const appState = session.getAppState();
    assert.equal(appState.status, "planning");
    assert.equal(appState.permissionMode, "plan");
    assert.equal(appState.planState?.mode, "planning");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addModelUsage, emptyModelUsage, hasModelUsage } from "../../src/model/usage.js";
import { SessionStore } from "../../src/storage/sessionStore.js";

describe("model usage", () => {
  it("adds sparse provider usage into totals", () => {
    assert.deepEqual(addModelUsage(emptyModelUsage(), { inputTokens: 3, outputTokens: 4 }), { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    assert.deepEqual(addModelUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { totalTokens: 10 }), { inputTokens: 1, outputTokens: 2, totalTokens: 13 });
    assert.equal(hasModelUsage(undefined), false);
    assert.equal(hasModelUsage({ inputTokens: 0, outputTokens: 1, totalTokens: 1 }), true);
  });

  it("records model usage in session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-usage-"));
    const store = new SessionStore(root);

    await store.recordUsage("session-usage", { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    await store.recordUsage("session-usage", { inputTokens: 2, outputTokens: 3 });

    assert.deepEqual((await store.loadMetadata("session-usage"))?.usage, { inputTokens: 7, outputTokens: 10, totalTokens: 17 });
  });
});

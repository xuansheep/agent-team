import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addModelUsage, effectiveModelTokens, emptyModelUsage, hasModelUsage } from "../../src/model/usage.js";
import { SessionStore } from "../../src/storage/sessionStore.js";

describe("model usage", () => {
  it("adds sparse and cached provider usage into totals", () => {
    assert.deepEqual(addModelUsage(emptyModelUsage(), { inputTokens: 3, cachedInputTokens: 2, outputTokens: 4 }), {
      inputTokens: 3,
      cachedInputTokens: 2,
      outputTokens: 4,
      totalTokens: 7
    });
    assert.deepEqual(addModelUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { totalTokens: 10 }), {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 2,
      totalTokens: 13
    });
    assert.equal(effectiveModelTokens({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 }), 9);
    assert.equal(effectiveModelTokens({ inputTokens: 2, cachedInputTokens: 5, outputTokens: -1 }), 0);
    assert.equal(hasModelUsage(undefined), false);
    assert.equal(hasModelUsage({ cachedInputTokens: 1 }), true);
  });

  it("records usage without changing request count", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-usage-"));
    const store = new SessionStore(root);

    await store.recordUsage("session-usage", { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    await store.recordUsage("session-usage", { inputTokens: 2, outputTokens: 3 });

    const metadata = await store.loadMetadata("session-usage");
    assert.deepEqual(metadata?.usage, { inputTokens: 7, cachedInputTokens: 0, outputTokens: 10, totalTokens: 17 });
    assert.equal(metadata?.modelRequestCount, undefined);
  });

  it("atomically records every successful model response even without usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-responses-"));
    const store = new SessionStore(root);

    await Promise.all([
      store.recordModelResponse("session-responses", { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, totalTokens: 12 }),
      store.recordModelResponse("session-responses")
    ]);

    const metadata = await store.loadMetadata("session-responses");
    assert.equal(metadata?.modelRequestCount, 2);
    assert.deepEqual(metadata?.usage, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, totalTokens: 12 });
  });
});

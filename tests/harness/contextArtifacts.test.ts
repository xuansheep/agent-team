import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/storage/artifacts.js";
import { buildNodeMessages } from "../../src/harness/context.js";
import type { WorkflowNodeConfig } from "../../src/config/schema.js";

describe("artifact handoff reads", () => {
  it("reads UTF-8 text in byte-safe pages", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-read-"));
    const store = new ArtifactStore(runDir);
    const ref = await store.writeText("product", "brief.md", "甲乙丙丁");
    const first = await store.readText(ref.artifactId, { maxBytes: 4 });
    const second = await store.readText(ref.artifactId, { offset: first.next_offset, maxBytes: 8 });

    assert.equal(first.content, "甲");
    assert.equal(first.truncated, true);
    assert.equal(second.content, "乙丙");
    assert.equal(second.offset, first.next_offset);
  });

  it("rejects tampered artifact content", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-integrity-"));
    const store = new ArtifactStore(runDir);
    const ref = await store.writeText("product", "brief.md", "trusted");
    await writeFile(ref.path, "tampered", "utf8");

    await assert.rejects(() => store.readText(ref.artifactId), /integrity check failed/);
  });

  it("injects referenced artifacts into the downstream node context", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-context-"));
    const store = new ArtifactStore(runDir);
    const ref = await store.writeText("product", "brief.md", "upstream content");
    const reads: string[] = [];
    const messages = await buildNodeMessages(
      { id: "review", role: "review", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Review.",
      { references: [{ artifact_ids: [ref.artifactId] }] },
      { runDir, onArtifactRead: (chunk) => { reads.push(chunk.artifact_id); } }
    );
    const user = messages.find((message) => message.role === "user");

    assert.match(String(user?.content), /upstream content/);
    assert.deepEqual(reads, [ref.artifactId]);
  });
});

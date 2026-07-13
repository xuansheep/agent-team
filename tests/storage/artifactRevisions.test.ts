import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/storage/artifacts.js";

describe("ArtifactStore revisions", () => {
  it("keeps same-name writes immutable and addressable by revision", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifacts-"));
    const store = new ArtifactStore(runDir);
    const first = await store.writeText("product", "prd.md", "v1", { attempt: 1, activation: 1 });
    const second = await store.writeText("product", "prd.md", "v2", { attempt: 1, activation: 2 });

    assert.equal(first.artifactId, "product/prd.md@r1");
    assert.equal(second.artifactId, "product/prd.md@r2");
    assert.equal(await readFile(first.path, "utf8"), "v1");
    assert.equal(await readFile(second.path, "utf8"), "v2");
    assert.equal(await store.has(first.artifactId), true);
    assert.equal((await store.record(second.artifactId))?.activation, 2);
  });

  it("allocates unique revisions across concurrent store instances", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-concurrency-"));
    const [first, second] = await Promise.all([
      new ArtifactStore(runDir).writeText("product", "prd.md", "v1"),
      new ArtifactStore(runDir).writeText("product", "prd.md", "v2")
    ]);

    assert.deepEqual(new Set([first.artifactId, second.artifactId]), new Set(["product/prd.md@r1", "product/prd.md@r2"]));
    assert.equal(await new ArtifactStore(runDir).has(first.artifactId), true);
    assert.equal(await new ArtifactStore(runDir).has(second.artifactId), true);
  });
});

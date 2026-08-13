import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots } from "../../src/workflow/workspaceSnapshot.js";

describe("workspace snapshots", () => {
  it("detects source changes and excludes generated directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-workspace-snapshot-"));
    await writeFile(join(cwd, "source.ts"), "one", "utf8");
    const before = await captureWorkspaceSnapshot(cwd);
    await writeFile(join(cwd, "source.ts"), "two", "utf8");
    const after = await captureWorkspaceSnapshot(cwd);
    const diff = diffWorkspaceSnapshots(before, after);
    assert.equal(diff.changed, true);
    assert.deepEqual(diff.changed_paths, ["source.ts"]);
  });

  it("marks bounded snapshots incomplete instead of silently claiming completeness", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-workspace-limit-"));
    await writeFile(join(cwd, "large.txt"), "abcdef", "utf8");
    const snapshot = await captureWorkspaceSnapshot(cwd, { maxBytes: 2 });
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.file_count, 0);
  });
});

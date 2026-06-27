import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorkspacePath, isPathInsideOrSame } from "../../src/security/pathBoundary.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-path-boundary-"));
}

describe("path boundary", () => {
  it("allows paths inside the workspace", async () => {
    const cwd = await workspace();
    const resolved = resolveWorkspacePath(cwd, "src/index.ts");

    assert.equal(isPathInsideOrSame(cwd, resolved), true);
    assert.equal(resolved.endsWith(join("src", "index.ts")), true);
  });

  it("rejects relative and absolute paths outside the workspace", async () => {
    const cwd = await workspace();
    const outside = join(dirname(cwd), "outside.txt");

    assert.throws(() => resolveWorkspacePath(cwd, "../outside.txt"), /escapes workspace/);
    assert.throws(() => resolveWorkspacePath(cwd, outside), /escapes workspace/);
    assert.equal(isPathInsideOrSame(cwd, outside), false);
  });

  it("blocks local file writes that target outside the workspace", async () => {
    const cwd = await workspace();
    const outside = join(dirname(cwd), "outside-write.txt");
    const tools = createLocalToolRegistry();

    await assert.rejects(
      () => tools.get("Write").execute({ file_path: outside, content: "bad" }, { cwd }),
      /escapes workspace/
    );
  });
});

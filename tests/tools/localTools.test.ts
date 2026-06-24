import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-tools-"));
}

describe("local tools", () => {
  it("reads, writes, and edits files", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    await tools.get("Write").execute({ file_path: "a.txt", content: "hello" }, { cwd });
    await tools.get("Edit").execute({ file_path: "a.txt", old_string: "hello", new_string: "world" }, { cwd });
    const result = await tools.get("Read").execute({ file_path: "a.txt" }, { cwd });

    assert.match(result.output ?? "", /world/);
  });


  it("writes user deliverables into run artifacts", async () => {
    const cwd = await workspace();
    const runDir = join(cwd, ".runs", "run-1");
    const tools = createLocalToolRegistry();

    const result = await tools.get("ArtifactWrite").execute({ name: "report.md", content: "# Report\nDone.", description: "User report" }, { cwd, runDir, nodeId: "dev" });

    assert.equal(result.artifact_id, "dev/report.md");
    assert.equal(result.description, "User report");
    assert.match(result.path ?? "", /artifacts.*dev.*report\.md/);
    assert.equal(await readFile(join(runDir, "artifacts", "dev", "report.md"), "utf8"), "# Report\nDone.");
  });

  it("rejects artifact names with path traversal", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    await assert.rejects(() => tools.get("ArtifactWrite").execute({ name: "../report.md", content: "bad", description: "bad" }, { cwd, runDir: join(cwd, ".runs", "run-1"), nodeId: "dev" }), /artifact name/);
  });

  it("registers command tools", () => {
    const tools = createLocalToolRegistry();

    assert.equal(tools.get("Bash").name, "Bash");
    assert.equal(tools.get("PowerShell").name, "PowerShell");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { normalizeGlobPatternForFastGlob } from "../../src/tools/local/glob.js";

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
    const runDir = join(cwd, ".session", "run-1");
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

    await assert.rejects(() => tools.get("ArtifactWrite").execute({ name: "../report.md", content: "bad", description: "bad" }, { cwd, runDir: join(cwd, ".session", "run-1"), nodeId: "dev" }), /artifact name/);
  });

  it("registers command tools", () => {
    const tools = createLocalToolRegistry();

    assert.equal(tools.get("Bash").name, "Bash");
    assert.equal(tools.get("PowerShell").name, "PowerShell");
  });

  it("finds hidden AGENTS files with absolute platform paths", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".einsteins"), { recursive: true });
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(join(cwd, ".agents", "AGENTS.md"), "Project instructions.\n", "utf8");
    const tools = createLocalToolRegistry();

    const result = await tools.get("Glob").execute({ pattern: join(cwd, "**", "AGENTS.md") }, { cwd });

    assert.match(result.output ?? "", /[.]agents[\\/]AGENTS[.]md/);
  });

  it("normalizes glob backslashes only for Windows patterns", () => {
    assert.equal(normalizeGlobPatternForFastGlob("C:\\repo\\**\\AGENTS.md", "win32"), "C:/repo/**/AGENTS.md");
    assert.equal(normalizeGlobPatternForFastGlob("dir\\*.ts", "linux"), "dir\\*.ts");
  });

  it("marks local tools with safety metadata", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    for (const name of ["Read", "LS", "Glob", "Grep"]) {
      assert.equal(tools.get(name).isReadOnly?.(), true, `${name} should be read-only`);
      assert.equal(tools.get(name).isConcurrencySafe?.(), true, `${name} should be concurrency-safe`);
    }

    for (const name of ["Write", "Edit", "MultiEdit", "Bash", "PowerShell"]) {
      assert.equal(tools.get(name).isConcurrencySafe?.(), false, `${name} should stay serial`);
    }

    assert.equal(await tools.get("Write").writesPlanFile?.({ file_path: ".session/plans/session-1.md" }, { cwd }), true);
    assert.equal(await tools.get("Write").writesPlanFile?.({ file_path: "src/index.ts" }, { cwd }), false);
    assert.equal(await tools.get("Bash").isDestructive?.({ command: "rm -rf dist" }), true);
    assert.equal(await tools.get("Bash").isDestructive?.({ command: "npm test" }), false);
    assert.equal(await tools.get("PowerShell").isDestructive?.({ command: "Remove-Item foo" }), true);
  });

});

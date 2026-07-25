import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { normalizeGlobPatternForFastGlob } from "../../src/tools/local/glob.js";
import { cleanPowerShellOutput, createPowerShellProvider, executeBash } from "../../src/tools/local/shellProvider.js";

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

    assert.equal(result.artifact_id, "dev/report.md@r1");
    assert.equal(result.description, "User report");
    assert.match(result.path ?? "", /artifacts.*dev.*r0001-report\.md/);
    assert.equal(await readFile(join(runDir, "artifacts", "dev", "r0001-report.md"), "utf8"), "# Report\nDone.");
  });

  it("imports attached images as immutable indexed artifacts", async () => {
    const cwd = await workspace();
    const runDir = join(cwd, ".session", "run-1");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    await writeFile(join(cwd, "diagram.png"), imageBytes);
    const tools = createLocalToolRegistry();

    const result = await tools.get("AttachImage").execute({ path: "diagram.png" }, { cwd, runDir, nodeId: "ui", attempt: 1, activation: 2 });

    assert.equal(result.artifact_id, "ui/diagram.png@r1");
    assert.deepEqual(await readFile(String(result.path)), imageBytes);
    const index = JSON.parse(await readFile(join(runDir, "artifacts", "index.json"), "utf8")) as { artifacts: Array<{ activation: number; kind?: string; media_type?: string }> };
    assert.equal(index.artifacts[0]?.activation, 2);
    assert.equal(index.artifacts[0]?.kind, "image");
    assert.equal(index.artifacts[0]?.media_type, "image/png");
  });

  it("rejects artifact names with path traversal", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    await assert.rejects(() => tools.get("ArtifactWrite").execute({ name: "../report.md", content: "bad", description: "bad" }, { cwd, runDir: join(cwd, ".session", "run-1"), nodeId: "dev" }), /artifact name/);
  });

  it("registers command tools", () => {
    const tools = createLocalToolRegistry();

    assert.equal(tools.get("Bash").name, "Bash");
    assert.equal(tools.has("PowerShell"), process.platform === "win32");
  });

  it("encodes PowerShell commands as UTF-16LE and cleans CLIXML errors", () => {
    const encoded = createPowerShellProvider("pwsh").spawnArgs('Write-Output "中文"').at(-1) ?? "";
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");

    assert.match(decoded, /Write-Output "中文"/);
    assert.equal(cleanPowerShellOutput('#< CLIXML\n<S S="Error">bad_x000D__x000A_more &amp; detail</S>'), "bad\nmore & detail");
  });

  it("finds hidden AGENTS files with absolute platform paths", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".einsteins"), { recursive: true });
    await writeFile(join(cwd, ".einsteins", "AGENTS.md"), "Project instructions.\n", "utf8");
    const tools = createLocalToolRegistry();

    const result = await tools.get("Glob").execute({ pattern: join(cwd, "**", "AGENTS.md") }, { cwd });

    assert.match(result.output ?? "", /[.]einsteins[\\/]AGENTS[.]md/);
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

    for (const name of ["Write", "Edit", "MultiEdit", "Bash", ...(process.platform === "win32" ? ["PowerShell"] : [])]) {
      assert.equal(tools.get(name).isConcurrencySafe?.(), false, `${name} should stay serial`);
    }

    const planFilePath = join(cwd, ".einsteins", "projects", "test", "session-1", "plans", "plan.md");
    assert.equal(await tools.get("Write").writesPlanFile?.({ file_path: planFilePath }, { cwd, planFilePath }), true);
    assert.equal(await tools.get("Write").writesPlanFile?.({ file_path: "src/index.ts" }, { cwd }), false);
    assert.equal(await tools.get("Bash").isDestructive?.({ command: "rm -rf dist" }), true);
    assert.equal(await tools.get("Bash").isDestructive?.({ command: "npm test" }), false);
    if (process.platform === "win32") {
      assert.equal(await tools.get("PowerShell").isDestructive?.({ command: "Remove-Item foo" }), true);
    }
  });

  it("persists large Bash output once without duplicating the threshold chunk", async () => {
    const cwd = await workspace();
    const outputDir = join(cwd, "shell-output");

    const result = await executeBash("printf '%0200d' 0", { cwd, timeoutMs: 3000, outputDir, maxOutputLength: 100 });

    assert.equal(result.code, 0);
    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 100);
    const persisted = await readFile(String(result.persistedOutputPath), "utf8");
    assert.equal((persisted.match(/0/g) ?? []).length, 200);
  });

  it("returns exit code 124 when Bash times out", async () => {
    const cwd = await workspace();
    const result = await settlesWithin(executeBash("while :; do :; done", { cwd, timeoutMs: 50 }), 3000);

    assert.equal(result.timedOut, true);
    assert.equal(result.interrupted, false);
    assert.equal(result.code, 124);
  });

  it("kills nested Bash process trees when aborted", async () => {
    const cwd = await workspace();
    const scriptPath = join(cwd, "spawn-child.cjs");
    const pidPath = join(cwd, "processes.json");
    await writeFile(scriptPath, [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync('processes.json', JSON.stringify({ parent: process.pid, child: child.pid }));",
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");

    const controller = new AbortController();
    const execution = executeBash("node ./spawn-child.cjs", { cwd, timeoutMs: 10000, signal: controller.signal });
    const processes = JSON.parse(await waitForFile(pidPath)) as { parent: number; child: number };
    try {
      controller.abort();
      const result = await settlesWithin(execution, 3000);
      assert.equal(result.interrupted, true);
      await waitForProcessExit(processes.parent, 3000);
      await waitForProcessExit(processes.child, 3000);
      assert.equal(isProcessRunning(processes.parent), false);
      assert.equal(isProcessRunning(processes.child), false);
    } finally {
      forceKill(processes.child);
      forceKill(processes.parent);
    }
  });

});

async function waitForFile(path: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT")) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKill(pid: number): void {
  if (!isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for a failed process-tree assertion.
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Shell abort did not settle")), timeoutMs))
  ]);
}

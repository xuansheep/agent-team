import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { normalizeGlobPatternForFastGlob } from "../../src/tools/local/glob.js";
import { cleanPowerShellOutput, createPowerShellProvider, executeBash, executePowerShell } from "../../src/tools/local/shellProvider.js";
import { hasUnmanagedBackgroundProcess } from "../../src/tools/local/shellPolicy.js";
import type { ManagedProcessLifecycleEvent } from "../../src/tools/local/managedProcess.js";

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

  it("refuses WebFetch against private and non-http targets", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/admin",
      "http://[::1]/",
      "http://10.0.0.5/",
      "file:///etc/passwd"
    ]) {
      await assert.rejects(() => tools.get("WebFetch").execute({ url }, { cwd }), /private address|only http/, `expected ${url} to be refused`);
    }
  });

  it("keeps Glob and Grep inside the workspace", async () => {
    const cwd = await workspace();
    const outside = join(cwd, "..", "outside-secret.txt");
    await writeFile(outside, "AKIAIOSFODNN7EXAMPLE\n", "utf8");
    const tools = createLocalToolRegistry();

    await assert.rejects(() => tools.get("Glob").execute({ pattern: "../**/outside-secret.txt" }, { cwd }), /escapes workspace/);
    await assert.rejects(() => tools.get("Grep").execute({ pattern: "AKIA", glob: "../**/*" }, { cwd }), /escapes workspace/);
    await assert.rejects(() => tools.get("Glob").execute({ pattern: join(cwd, "..", "**", "*.txt") }, { cwd }), /escapes workspace/);
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

  it("settles a timed-out PowerShell command when a descendant keeps stdio open", { skip: process.platform !== "win32" }, async () => {
    const cwd = await workspace();
    const scriptPath = join(cwd, "hold-open.cjs");
    await writeFile(scriptPath, "setTimeout(() => {}, 1500);\n", "utf8");
    const executable = process.execPath.replace(/'/g, "''");
    const command = `Start-Process -FilePath '${executable}' -ArgumentList './hold-open.cjs' -NoNewWindow`;

    const result = await settlesWithin(executePowerShell(command, { cwd, timeoutMs: 50 }), 3500);

    assert.equal(result.timedOut, true);
    assert.equal(result.code, 124);
  });

  it("detects unmanaged background processes without confusing redirection or foreground composition", () => {
    assert.equal(hasUnmanagedBackgroundProcess("python -m http.server 4173 > out.log 2>&1 &", "bash"), true);
    assert.equal(hasUnmanagedBackgroundProcess("npm test && npm run lint", "bash"), false);
    assert.equal(hasUnmanagedBackgroundProcess("python app.py > out.log 2>&1", "bash"), false);
    assert.equal(hasUnmanagedBackgroundProcess("python app.py &> out.log", "bash"), false);
    assert.equal(hasUnmanagedBackgroundProcess("Start-Process python -ArgumentList '-m','http.server'", "powershell"), true);
    assert.equal(hasUnmanagedBackgroundProcess("Start-Process python -ArgumentList '-V' -Wait", "powershell"), false);
    assert.equal(hasUnmanagedBackgroundProcess("& python -V", "powershell"), false);
    assert.equal(hasUnmanagedBackgroundProcess("Write-Output ready; & python -V", "powershell"), false);
    assert.equal(hasUnmanagedBackgroundProcess("$version = & python -V", "powershell"), false);
  });

  it("starts, inspects, and stops node-scoped managed processes", async () => {
    const cwd = await workspace();
    const runDir = join(cwd, ".session", "run-process");
    const scriptPath = join(cwd, "managed-child.cjs");
    await writeFile(scriptPath, "process.stdout.write('ready'); setInterval(() => {}, 1000);\n", "utf8");
    const events: ManagedProcessLifecycleEvent[] = [];
    const tools = createLocalToolRegistry({ onManagedProcessEvent: (event) => { events.push(event); } });

    const started = await tools.get("ProcessStart").execute({
      executable: process.execPath,
      args: [scriptPath]
    }, { cwd, runDir });
    const data = started.data as { process_id: string; pid: number };
    try {
      assert.equal(isProcessRunning(data.pid), true);
      const status = await tools.get("ProcessStatus").execute({ process_id: data.process_id }, { cwd, runDir });
      assert.equal((status.data as { state: string }).state, "running");

      const stopped = await tools.get("ProcessStop").execute({ process_id: data.process_id }, { cwd, runDir });
      assert.equal((stopped.data as { state: string }).state, "exited");
      await waitForProcessExit(data.pid, 3000);
      assert.equal(isProcessRunning(data.pid), false);
      assert.deepEqual(events.map((event) => event.type), ["managed_process_started", "managed_process_stopped"]);
    } finally {
      forceKill(data.pid);
    }
  });

  it("automatically cleans managed processes when a node ends", async () => {
    const cwd = await workspace();
    const scriptPath = join(cwd, "managed-cleanup.cjs");
    await writeFile(scriptPath, "setInterval(() => {}, 1000);\n", "utf8");
    const events: ManagedProcessLifecycleEvent[] = [];
    const tools = createLocalToolRegistry({ onManagedProcessEvent: (event) => { events.push(event); } });

    const started = await tools.get("ProcessStart").execute({
      executable: process.execPath,
      args: [scriptPath]
    }, { cwd });
    const data = started.data as { pid: number };
    try {
      await tools.disposeManagedProcesses("node_complete");
      await waitForProcessExit(data.pid, 3000);
      assert.equal(isProcessRunning(data.pid), false);
      const lastEvent = events.at(-1);
      assert.equal(lastEvent?.type, "managed_process_stopped");
      assert.equal(lastEvent?.type === "managed_process_stopped" ? lastEvent.reason : undefined, "node_complete");
    } finally {
      forceKill(data.pid);
    }
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

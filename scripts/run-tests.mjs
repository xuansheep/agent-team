import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { run } from "node:test";

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(path));
    if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

process.env.EINSTEINS_HOME ??= resolve(".tmp", "test-home", String(process.pid));

const root = resolve("dist-test", "tests");
const requested = process.argv.slice(2);
const files = requested.length > 0
  ? requested.map(toCompiledTestPath)
  : await collectTests(root);
files.sort();

if (files.length === 0) throw new Error("No test files found");

const startedAt = performance.now();
const failedFiles = new Set();
let activeFile;
let activeStartedAt = 0;
let completedFiles = 0;

console.log(`[test] Running ${files.length} test file${files.length === 1 ? "" : "s"} sequentially`);

const runner = run({ files, concurrency: 1, isolation: "none" });
const heartbeat = setInterval(() => {
  if (!activeFile) return;
  console.log(`[test] [${completedFiles + 1}/${files.length}] RUNNING ${displayPath(activeFile)} (${formatDuration(performance.now() - activeStartedAt)})`);
}, 10_000);
heartbeat.unref();

runner.on("test:start", (event) => {
  if (!event.file || resolve(event.file) === activeFile) return;
  completeActiveFile();
  activeFile = resolve(event.file);
  activeStartedAt = performance.now();
  console.log(`[test] [${completedFiles + 1}/${files.length}] START ${displayPath(activeFile)}`);
});

runner.on("test:fail", (event) => {
  if (event.file) failedFiles.add(resolve(event.file));
  const error = event.details?.error;
  if (!error || error.failureType === "subtestsFailed") return;
  console.error(`[test] FAILURE ${event.name}\n${error.stack ?? error.message ?? String(error)}`);
});

runner.on("test:summary", (summary) => {
  completeActiveFile();
  clearInterval(heartbeat);
  const status = summary.success ? "PASS" : "FAIL";
  console.log(`[test] ${status} ${completedFiles}/${files.length} files, ${summary.counts.passed}/${summary.counts.tests} tests passed (${formatDuration(performance.now() - startedAt)})`);
  if (!summary.success) process.exitCode = 1;
});

runner.on("error", (error) => {
  clearInterval(heartbeat);
  console.error(`[test] Runner error: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});

runner.resume();

function completeActiveFile() {
  if (!activeFile) return;
  completedFiles += 1;
  const status = failedFiles.has(activeFile) ? "FAIL" : "PASS";
  console.log(`[test] [${completedFiles}/${files.length}] ${status} ${displayPath(activeFile)} (${formatDuration(performance.now() - activeStartedAt)})`);
  activeFile = undefined;
}

function toCompiledTestPath(input) {
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("tests/")) {
    return resolve("dist-test", normalized.replace(/\.(?:ts|tsx)$/, ".js"));
  }
  if (normalized.startsWith("dist-test/tests/")) return resolve(normalized);
  return resolve(input);
}

function displayPath(path) {
  return relative(resolve("dist-test"), path).replaceAll("\\", "/");
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

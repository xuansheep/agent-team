import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { run } from "node:test";
import killProcessTree from "tree-kill";

const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_FILE_TIMEOUT_MS = 120_000;
const TIMEOUT_EXIT_CODE = 124;
const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[2] === "--worker") {
  await runWorker(process.argv.slice(3));
} else {
  await runParent(process.argv.slice(2));
}

async function runParent(args) {
  const options = parseOptions(args);
  if (options.help) {
    printHelp();
    return;
  }

  process.env.EINSTEINS_HOME = resolve(".tmp", "test-home", String(process.pid));
  const files = options.files.length > 0
    ? options.files.map(toCompiledTestPath)
    : (await collectSourceTests(resolve("tests")))
      .map((path) => toCompiledTestPath(relative(resolve(), path)));
  files.sort();

  if (files.length === 0) throw new Error("No test files found");

  const startedAt = performance.now();
  let activeChild;
  let passedFiles = 0;
  let failedFiles = 0;
  let skippedFiles = 0;

  const terminateActiveChild = () => terminateProcessTree(activeChild);
  let terminating = false;
  const terminateRunner = (exitCode) => {
    if (terminating) return;
    terminating = true;
    if (!activeChild?.pid) {
      process.exit(exitCode);
      return;
    }
    terminateActiveChild();
    setTimeout(() => process.exit(exitCode), 500);
  };
  process.once("SIGINT", () => terminateRunner(130));
  process.once("SIGTERM", () => terminateRunner(143));

  console.log(
    `[test] Running ${files.length} test file${files.length === 1 ? "" : "s"} sequentially ` +
    `(test timeout ${formatDuration(options.testTimeoutMs)}, file timeout ${formatDuration(options.fileTimeoutMs)})`
  );

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const display = displayPath(file);
    const fileStartedAt = performance.now();
    console.log(`[test] [${index + 1}/${files.length}] START ${display}`);

    const result = await runFileProcess({
      file,
      testTimeoutMs: options.testTimeoutMs,
      fileTimeoutMs: options.fileTimeoutMs,
      skipPattern: options.skipPattern,
      onSpawn: (child) => {
        activeChild = child;
      },
      onSettled: () => {
        activeChild = undefined;
      }
    });
    const elapsed = formatDuration(performance.now() - fileStartedAt);
    const timeoutOnly = result.timedOut || result.code === TIMEOUT_EXIT_CODE;

    if (timeoutOnly && options.timeoutPolicy === "skip") {
      skippedFiles += 1;
      console.warn(`[test] [${index + 1}/${files.length}] SKIP ${display} (timeout after ${elapsed})`);
      continue;
    }
    if (result.code === 0 && !result.timedOut) {
      passedFiles += 1;
      console.log(`[test] [${index + 1}/${files.length}] PASS ${display} (${elapsed})`);
      continue;
    }

    failedFiles += 1;
    const reason = timeoutOnly ? "TIMEOUT" : "FAIL";
    console.error(`[test] [${index + 1}/${files.length}] ${reason} ${display} (${elapsed})`);
  }

  const status = failedFiles === 0 ? "PASS" : "FAIL";
  console.log(
    `[test] ${status} ${files.length}/${files.length} files: ` +
    `${passedFiles} passed, ${failedFiles} failed, ${skippedFiles} skipped ` +
    `(${formatDuration(performance.now() - startedAt)})`
  );
  if (failedFiles > 0) process.exitCode = 1;
}

async function runWorker(args) {
  const [file, timeoutValue, skipPattern] = args;
  const timeout = positiveInteger(timeoutValue, DEFAULT_TEST_TIMEOUT_MS);
  let failures = 0;
  let timeoutFailures = 0;

  const runner = run({
    files: [file],
    concurrency: 1,
    isolation: "none",
    timeout,
    ...(skipPattern ? { testSkipPatterns: skipPattern } : {})
  });

  const exitCode = await new Promise((resolveExitCode) => {
    runner.on("test:fail", (event) => {
      const error = event.details?.error;
      if (!error || error.failureType === "subtestsFailed") return;
      failures += 1;
      if (isTimeoutFailure(error)) timeoutFailures += 1;
      console.error(`[test] FAILURE ${event.name}\n${error.stack ?? error.message ?? String(error)}`);
    });
    runner.on("test:summary", (summary) => {
      if (summary.success) {
        resolveExitCode(0);
        return;
      }
      resolveExitCode(failures > 0 && failures === timeoutFailures ? TIMEOUT_EXIT_CODE : 1);
    });
    runner.on("error", (error) => {
      console.error(`[test] Runner error: ${error.stack ?? error.message}`);
      resolveExitCode(1);
    });
    runner.resume();
  });

  process.exitCode = exitCode;
}

function runFileProcess({
  file,
  testTimeoutMs,
  fileTimeoutMs,
  skipPattern,
  onSpawn,
  onSettled
}) {
  return new Promise((resolveResult) => {
    const childArgs = [
      scriptPath,
      "--worker",
      file,
      String(testTimeoutMs),
      skipPattern ?? ""
    ];
    const child = spawn(process.execPath, childArgs, {
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    onSpawn(child);

    let settled = false;
    let timedOut = false;
    let killGraceTimer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killGraceTimer);
      onSettled();
      resolveResult({ code: code ?? 1, timedOut });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.pid) {
        finish(TIMEOUT_EXIT_CODE);
        return;
      }
      terminateProcessTree(child);
      killGraceTimer = setTimeout(() => finish(TIMEOUT_EXIT_CODE), 2_000);
      killGraceTimer.unref();
    }, fileTimeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      console.error(`[test] Failed to start ${displayPath(file)}: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code) => finish(timedOut ? TIMEOUT_EXIT_CODE : code));
  });
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  const fallback = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited between the timeout and cleanup.
    }
  };
  try {
    killProcessTree(child.pid, "SIGKILL", (error) => {
      if (error) fallback();
    });
  } catch {
    fallback();
  }
}

function parseOptions(args) {
  const files = [];
  let testTimeoutMs = positiveInteger(process.env.TEST_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS);
  let fileTimeoutMs = positiveInteger(process.env.TEST_FILE_TIMEOUT_MS, DEFAULT_FILE_TIMEOUT_MS);
  let timeoutPolicy = process.env.TEST_TIMEOUT_POLICY === "skip" ? "skip" : "fail";
  let skipPattern = process.env.TEST_SKIP_PATTERN || undefined;
  let help = false;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("--test-timeout-ms=")) {
      testTimeoutMs = positiveInteger(arg.slice("--test-timeout-ms=".length), DEFAULT_TEST_TIMEOUT_MS);
    } else if (arg.startsWith("--file-timeout-ms=")) {
      fileTimeoutMs = positiveInteger(arg.slice("--file-timeout-ms=".length), DEFAULT_FILE_TIMEOUT_MS);
    } else if (arg.startsWith("--timeout-policy=")) {
      const value = arg.slice("--timeout-policy=".length);
      if (value !== "fail" && value !== "skip") throw new Error(`Invalid timeout policy: ${value}`);
      timeoutPolicy = value;
    } else if (arg.startsWith("--skip-pattern=")) {
      skipPattern = arg.slice("--skip-pattern=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      files.push(arg);
    }
  }

  if (fileTimeoutMs <= testTimeoutMs) {
    throw new Error("--file-timeout-ms must be greater than --test-timeout-ms");
  }
  return { files, testTimeoutMs, fileTimeoutMs, timeoutPolicy, skipPattern, help };
}

async function collectSourceTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceTests(path));
    if (entry.isFile() && /[.]test[.]tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
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

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function isTimeoutFailure(error) {
  return /timeout/i.test([
    error.code,
    error.failureType,
    error.message
  ].filter(Boolean).join(" "));
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function printHelp() {
  console.log(`Usage: node scripts/run-tests.mjs [options] [test files...]

Options:
  --test-timeout-ms=<ms>   Timeout for one test case (default: 30000)
  --file-timeout-ms=<ms>   Hard timeout for one test file process (default: 120000)
  --timeout-policy=fail    Continue after timeout and fail the run (default)
  --timeout-policy=skip    Continue after timeout and count pure timeouts as skipped
  --skip-pattern=<regexp>  Skip test names matching the regular expression
  -h, --help               Show this help

Environment equivalents:
  TEST_TIMEOUT_MS, TEST_FILE_TIMEOUT_MS, TEST_TIMEOUT_POLICY, TEST_SKIP_PATTERN`);
}

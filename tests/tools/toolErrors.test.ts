import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool, failureFingerprint, ShellExecutionError, toolFailureResult, ToolExecutionError } from "../../src/tools/errors.js";
import { ShellStartError } from "../../src/tools/local/shellProvider.js";
import {
  SHELL_COMMAND_MAX_CHARS,
  SHELL_LARGE_INLINE_CONTENT_CHARS,
  shellToolPrompt,
  validateShellCommandInput
} from "../../src/tools/local/shellPolicy.js";
import type { Tool } from "../../src/tools/types.js";

describe("tool failure protocol", () => {
  it("turns legacy error results into typed failures", async () => {
    const legacy: Tool = {
      name: "Legacy",
      description: "legacy",
      input_schema: { type: "object" },
      async execute() {
        return { error: "legacy failed", exit_code: 1 };
      }
    };

    await assert.rejects(() => executeTool(legacy, {}, { cwd: process.cwd() }), ToolExecutionError);
  });

  it("preserves shell stdout, stderr, exit code and executor metadata", () => {
    const result = toolFailureResult(new ShellExecutionError("out", "err", 9, false, false, "powershell", "pwsh.exe", true, true, "shell.log", 42, "ordinary failure"));

    assert.deepEqual(result, {
      is_error: true,
      error: "Exit code 9\nerr\nout",
      output: "out",
      stderr: "err",
      exit_code: 9,
      data: {
        executor: "powershell",
        executable: "pwsh.exe",
        fallback: true,
        interrupted: false,
        timed_out: false,
        truncated: true,
        persisted_output_path: "shell.log",
        persisted_output_size: 42,
        return_code_interpretation: "ordinary failure",
        failure_category: "shell.exit.nonzero",
        failure_fingerprint: failureFingerprint("shell.exit.nonzero", "powershell:9:err")
      }
    });
  });

  it("classifies stable shell failure categories", () => {
    const heredoc = toolFailureResult(new ShellExecutionError(
      "",
      "warning: here-document at line 1 delimited by end-of-file",
      2,
      false,
      false,
      "bash",
      "bash.exe",
      false,
      false
    ));
    const git = toolFailureResult(new ShellExecutionError(
      "",
      "fatal: not a git repository (or any of the parent directories): .git",
      128,
      false,
      false,
      "bash",
      "bash.exe",
      false,
      false
    ));
    const tooLong = toolFailureResult(new ShellStartError("spawn ENAMETOOLONG", "bash.exe"));

    assert.equal((heredoc.data as { failure_category?: string }).failure_category, "shell.syntax.heredoc_unterminated");
    assert.equal((git.data as { failure_category?: string }).failure_category, "git.not_repository");
    assert.equal((tooLong.data as { failure_category?: string }).failure_category, "shell.spawn.command_too_long");
  });

  it("enforces shell command boundaries without rejecting valid short commands", () => {
    const inlinePrefix = "cat <<EOF\n";
    const inlineBelowLimit = inlinePrefix + "x".repeat(SHELL_LARGE_INLINE_CONTENT_CHARS - inlinePrefix.length - 1);
    const inlineAtLimit = inlinePrefix + "x".repeat(SHELL_LARGE_INLINE_CONTENT_CHARS - inlinePrefix.length);

    assert.doesNotThrow(() => validateShellCommandInput(inlineBelowLimit, "bash"));
    assert.throws(() => validateShellCommandInput(inlineAtLimit, "bash"), (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal((error.result?.data as { failure_category?: string }).failure_category, "shell.input.large_inline_content");
      return true;
    });
    assert.doesNotThrow(() => validateShellCommandInput("x".repeat(SHELL_COMMAND_MAX_CHARS), "powershell"));
    assert.throws(() => validateShellCommandInput("x".repeat(SHELL_COMMAND_MAX_CHARS + 1), "powershell"), (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal((error.result?.data as { failure_category?: string }).failure_category, "shell.input.command_too_long");
      return true;
    });
  });

  it("directs shell callers to dedicated file tools", () => {
    const prompt = shellToolPrompt("PowerShell");

    assert.match(prompt, /Read files with Read/);
    assert.match(prompt, /Edit or MultiEdit/);
    assert.match(prompt, /Write files with Write/);
    assert.match(prompt, /PowerShell/);
  });

  it("allows explicitly interpreted informational non-zero results", async () => {
    const informational: Tool = {
      name: "Search",
      description: "search",
      input_schema: { type: "object" },
      async execute() {
        return { exit_code: 1, data: { semantic_success: true } };
      }
    };

    assert.equal((await executeTool(informational, {}, { cwd: process.cwd() })).exit_code, 1);
  });
});

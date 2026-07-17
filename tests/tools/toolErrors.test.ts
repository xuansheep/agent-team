import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTool, ShellExecutionError, toolFailureResult, ToolExecutionError } from "../../src/tools/errors.js";
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
        return_code_interpretation: "ordinary failure"
      }
    });
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

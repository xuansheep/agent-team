import { join } from "node:path";
import { z } from "zod";
import { ShellExecutionError } from "../errors.js";
import { Tool } from "../types.js";
import { interpretBashCommand } from "./commandSemantics.js";
import { executeBash } from "./shellProvider.js";
import { isDestructiveShellCommand, isReadOnlyShellCommand } from "./shellSafety.js";

const inputSchema = z.object({ command: z.string().min(1), timeout_ms: z.number().int().positive().default(120000) });

export const bashTool: Tool = {
  name: "Bash",
  description: "Run a Bash command in the workspace. On Windows this requires Git Bash; commands are never reinterpreted by another shell.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
    required: ["command"]
  },
  isReadOnly: isReadOnlyShellCommand,
  isConcurrencySafe: () => false,
  isDestructive: isDestructiveShellCommand,
  requiresUserInteraction: () => false,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const result = await executeBash(parsed.command, {
      cwd: context.cwd,
      timeoutMs: parsed.timeout_ms,
      signal: context.abortSignal,
      outputDir: context.runDir ? join(context.runDir, "shell-output") : undefined
    });
    const interpretation = interpretBashCommand(parsed.command, result.code, result.stdout, result.stderr);
    await context.auditSink?.({
      type: "shell_command",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: "Bash",
      command: parsed.command,
      destructive: isDestructiveShellCommand(parsed),
      executor: "bash",
      executable: result.executable,
      fallback: false,
      exit_code: result.code
    });
    if (interpretation.isError || result.interrupted || result.timedOut) {
      throw new ShellExecutionError(result.stdout, result.stderr, result.code, result.interrupted, result.timedOut, "bash", result.executable, false, result.truncated, result.persistedOutputPath, result.persistedOutputSize, interpretation.message);
    }
    return {
      output: result.stdout,
      stderr: result.stderr || undefined,
      exit_code: result.code,
      data: {
        executor: "bash",
        executable: result.executable,
        fallback: false,
        timed_out: result.timedOut,
        truncated: result.truncated,
        persisted_output_path: result.persistedOutputPath,
        persisted_output_size: result.persistedOutputSize,
        semantic_success: true,
        return_code_interpretation: interpretation.message
      }
    };
  }
};

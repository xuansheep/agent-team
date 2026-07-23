import { join } from "node:path";
import { z } from "zod";
import { ShellExecutionError } from "../errors.js";
import { Tool } from "../types.js";
import { interpretPowerShellCommand } from "./commandSemantics.js";
import { executePowerShell } from "./shellProvider.js";
import { isDestructiveShellCommand, isReadOnlyPowerShellCommand } from "./shellSafety.js";
import { shellToolPrompt, validateShellCommandInput } from "./shellPolicy.js";

const inputSchema = z.object({ command: z.string().min(1), timeout_ms: z.number().int().positive().default(120000) });

export const powerShellTool: Tool = {
  name: "PowerShell",
  description: "Run a PowerShell command in the workspace on Windows",
  prompt: shellToolPrompt("PowerShell"),
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
    required: ["command"]
  },
  isReadOnly: isReadOnlyPowerShellCommand,
  isConcurrencySafe: () => false,
  isDestructive: isDestructiveShellCommand,
  requiresUserInteraction: () => false,
  async validateInput(input) {
    const parsed = inputSchema.parse(input);
    validateShellCommandInput(parsed.command, "powershell");
    return { result: true };
  },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (process.platform !== "win32") throw new Error("PowerShell is only supported on Windows");
    const result = await executePowerShell(parsed.command, {
      cwd: context.cwd,
      timeoutMs: parsed.timeout_ms,
      signal: context.abortSignal,
      outputDir: context.runDir ? join(context.runDir, "shell-output") : undefined
    });
    const interpretation = interpretPowerShellCommand(parsed.command, result.code, result.stdout, result.stderr);
    await context.auditSink?.({
      type: "shell_command",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: "PowerShell",
      command: parsed.command,
      destructive: isDestructiveShellCommand(parsed),
      executor: "powershell",
      executable: result.executable,
      fallback: false,
      exit_code: result.code
    });
    if (interpretation.isError || result.interrupted || result.timedOut) {
      throw new ShellExecutionError(result.stdout, result.stderr, result.code, result.interrupted, result.timedOut, "powershell", result.executable, false, result.truncated, result.persistedOutputPath, result.persistedOutputSize, interpretation.message);
    }
    return {
      output: result.stdout,
      stderr: result.stderr || undefined,
      exit_code: result.code,
      data: {
        executor: "powershell",
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

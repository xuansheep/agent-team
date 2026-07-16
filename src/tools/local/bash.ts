import { z } from "zod";
import { ShellExecutionError } from "../errors.js";
import { Tool } from "../types.js";
import { interpretBashCommand, interpretPowerShellCommand } from "./commandSemantics.js";
import { executeBash, executePowerShell, ShellStartError } from "./shellProvider.js";
import { isDestructiveShellCommand, isReadOnlyShellCommand } from "./shellSafety.js";

const inputSchema = z.object({ command: z.string().min(1), timeout_ms: z.number().int().positive().default(120000) });

export const bashTool: Tool = {
  name: "Bash",
  description: "Run a Bash command in the workspace. On Windows this uses Git Bash and falls back to PowerShell only when Bash cannot start.",
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
    let result;
    let executor: "bash" | "powershell" = "bash";
    let fallback = false;
    try {
      result = await executeBash(parsed.command, { cwd: context.cwd, timeoutMs: parsed.timeout_ms, signal: context.abortSignal });
    } catch (error) {
      if (!(error instanceof ShellStartError) || process.platform !== "win32") throw error;
      executor = "powershell";
      fallback = true;
      result = await executePowerShell(parsed.command, { cwd: context.cwd, timeoutMs: parsed.timeout_ms, signal: context.abortSignal });
    }

    const interpretation = executor === "bash"
      ? interpretBashCommand(parsed.command, result.code, result.stdout, result.stderr)
      : interpretPowerShellCommand(parsed.command, result.code, result.stdout, result.stderr);
    await context.auditSink?.({
      type: "shell_command",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: "Bash",
      command: parsed.command,
      destructive: isDestructiveShellCommand(parsed),
      executor,
      executable: result.executable,
      fallback,
      exit_code: result.code
    });
    if (interpretation.isError || result.interrupted) {
      throw new ShellExecutionError(result.stdout, result.stderr, result.code, result.interrupted, executor, result.executable, fallback, interpretation.message);
    }
    return {
      output: result.stdout,
      stderr: result.stderr || undefined,
      exit_code: result.code,
      data: {
        executor,
        executable: result.executable,
        fallback,
        semantic_success: true,
        return_code_interpretation: interpretation.message
      }
    };
  }
};

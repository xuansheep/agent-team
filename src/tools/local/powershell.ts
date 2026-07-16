import { z } from "zod";
import { ShellExecutionError } from "../errors.js";
import { Tool } from "../types.js";
import { interpretPowerShellCommand } from "./commandSemantics.js";
import { executePowerShell } from "./shellProvider.js";
import { isDestructiveShellCommand, isReadOnlyPowerShellCommand } from "./shellSafety.js";

const inputSchema = z.object({ command: z.string().min(1), timeout_ms: z.number().int().positive().default(120000) });

export const powerShellTool: Tool = {
  name: "PowerShell",
  description: "Run a PowerShell command in the workspace on Windows",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
    required: ["command"]
  },
  isReadOnly: isReadOnlyPowerShellCommand,
  isConcurrencySafe: () => false,
  isDestructive: isDestructiveShellCommand,
  requiresUserInteraction: () => false,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (process.platform !== "win32") throw new Error("PowerShell is only supported on Windows");
    const result = await executePowerShell(parsed.command, { cwd: context.cwd, timeoutMs: parsed.timeout_ms, signal: context.abortSignal });
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
    if (interpretation.isError || result.interrupted) {
      throw new ShellExecutionError(result.stdout, result.stderr, result.code, result.interrupted, "powershell", result.executable, false, interpretation.message);
    }
    return {
      output: result.stdout,
      stderr: result.stderr || undefined,
      exit_code: result.code,
      data: {
        executor: "powershell",
        executable: result.executable,
        fallback: false,
        semantic_success: true,
        return_code_interpretation: interpretation.message
      }
    };
  }
};

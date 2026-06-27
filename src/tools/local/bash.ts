import { spawn } from "node:child_process";
import { z } from "zod";
import { Tool } from "../types.js";
import { isDestructiveShellCommand } from "./shellSafety.js";

const inputSchema = z.object({ command: z.string().min(1), timeout_ms: z.number().int().positive().default(120000) });

export const bashTool: Tool = {
  name: "Bash",
  description: "Run a shell command in the workspace",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
    required: ["command"]
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: isDestructiveShellCommand,
  requiresUserInteraction: () => false,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const destructive = isDestructiveShellCommand(parsed);
    await context.auditSink?.({
      type: "shell_command",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: "Bash",
      command: parsed.command,
      destructive
    });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(parsed.command, { cwd: context.cwd, shell: true, windowsHide: true });
      } catch (error) {
        resolve({ error: error instanceof Error ? error.message : String(error), exit_code: 1 });
        return;
      }
      let output = "";
      let error = "";
      const timer = setTimeout(() => child.kill(), parsed.timeout_ms);
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { error += String(chunk); });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ error: err.message, exit_code: 1 });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ output, error, exit_code: code ?? 1 });
      });
    });
  }
};

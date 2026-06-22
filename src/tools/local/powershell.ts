import { spawn } from "node:child_process";
import { z } from "zod";
import { Tool } from "../types.js";

const inputSchema = z.object({ command: z.string().min(1), timeout_ms: z.number().int().positive().default(120000) });

export const powerShellTool: Tool = {
  name: "PowerShell",
  description: "Run a PowerShell command in the workspace on Windows",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
    required: ["command"]
  },
  execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (process.platform !== "win32") {
      return Promise.resolve({ error: "PowerShell is only supported on Windows in this MVP", exit_code: 1 });
    }
    return new Promise((resolve) => {
      const child = spawn("powershell", ["-NoProfile", "-Command", parsed.command], { cwd: context.cwd, windowsHide: true });
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

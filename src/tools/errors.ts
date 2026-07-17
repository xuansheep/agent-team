import type { Tool, ToolContext, ToolResult } from "./types.js";

export class ToolExecutionError extends Error {
  constructor(message: string, readonly result?: ToolResult) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export class ShellExecutionError extends ToolExecutionError {
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number,
    readonly interrupted: boolean,
    readonly timedOut: boolean,
    readonly executor: "bash" | "powershell",
    readonly executable: string,
    readonly fallback: boolean,
    readonly truncated: boolean,
    readonly persistedOutputPath?: string,
    readonly persistedOutputSize?: number,
    readonly interpretation?: string
  ) {
    super("Shell command failed");
    this.name = "ShellExecutionError";
  }
}

export async function executeTool(tool: Tool, input: unknown, context: ToolContext): Promise<ToolResult> {
  const validation = await tool.validateInput?.(input, context);
  if (validation?.result === false) throw new ToolExecutionError(validation.message);
  const result = await tool.execute(input, context);
  if (isFailureResult(result)) {
    throw new ToolExecutionError(result.error ?? `Tool exited with code ${result.exit_code ?? 1}`, result);
  }
  return result;
}

export function toolFailureResult(error: unknown): ToolResult {
  if (error instanceof ShellExecutionError) {
    return {
      is_error: true,
      error: formatToolError(error),
      output: error.stdout,
      stderr: error.stderr,
      exit_code: error.code,
      data: {
        executor: error.executor,
        executable: error.executable,
        fallback: error.fallback,
        interrupted: error.interrupted,
        timed_out: error.timedOut,
        truncated: error.truncated,
        persisted_output_path: error.persistedOutputPath,
        persisted_output_size: error.persistedOutputSize,
        return_code_interpretation: error.interpretation
      }
    };
  }
  if (error instanceof ToolExecutionError && error.result) {
    return { ...error.result, is_error: true, error: formatToolError(error) };
  }
  return { is_error: true, error: formatToolError(error) };
}

export function formatToolError(error: unknown): string {
  let content: string;
  if (error instanceof ShellExecutionError) {
    content = [
      `Exit code ${error.code}`,
      error.timedOut ? "Command timed out before completion" : "",
      error.interrupted ? "Command was aborted before completion" : "",
      error.stderr,
      error.stdout
    ].filter(Boolean).join("\n").trim() || "Command failed with no output";
  } else if (error instanceof ToolExecutionError && error.result?.error) {
    content = error.result.error;
  } else {
    content = error instanceof Error ? error.message : String(error);
  }
  if (content.length <= 10_000) return content;
  return `${content.slice(0, 5_000)}\n\n... [${content.length - 10_000} characters truncated] ...\n\n${content.slice(-5_000)}`;
}

function isFailureResult(result: ToolResult): boolean {
  if (result.is_error === true) return true;
  if (typeof result.exit_code === "number" && result.exit_code !== 0 && !semanticSuccess(result)) return true;
  return Boolean(result.error && result.exit_code === undefined);
}

function semanticSuccess(result: ToolResult): boolean {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return false;
  return (result.data as { semantic_success?: unknown }).semantic_success === true;
}

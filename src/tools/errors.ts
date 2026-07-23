import { createHash } from "node:crypto";
import { ShellStartError } from "./local/shellProvider.js";
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
    const failure = classifyShellExecutionError(error);
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
        return_code_interpretation: error.interpretation,
        failure_category: failure.category,
        failure_fingerprint: failureFingerprint(failure.category, failure.detail)
      }
    };
  }
  if (error instanceof ToolExecutionError && error.result) {
    return { ...error.result, is_error: true, error: formatToolError(error) };
  }
  if (error instanceof ShellStartError) {
    const category = /ENAMETOOLONG|command line is too long|Argument list too long/i.test(error.message)
      ? "shell.spawn.command_too_long"
      : "shell.spawn.failed";
    return toolPolicyFailureResult(category, formatToolError(error), error.executable ?? "");
  }
  return { is_error: true, error: formatToolError(error) };
}

export function toolPolicyFailureResult(category: string, message: string, detail = ""): ToolResult {
  return {
    is_error: true,
    error: message,
    data: {
      failure_category: category,
      failure_fingerprint: failureFingerprint(category, detail)
    }
  };
}

export function toolFailureInfo(result: ToolResult | undefined): { category: string; fingerprint: string } | undefined {
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) return undefined;
  const data = result.data as { failure_category?: unknown; failure_fingerprint?: unknown };
  if (typeof data.failure_category !== "string" || typeof data.failure_fingerprint !== "string") return undefined;
  return { category: data.failure_category, fingerprint: data.failure_fingerprint };
}

export function failureFingerprint(category: string, detail = ""): string {
  return createHash("sha256").update(category + ":" + detail).digest("hex");
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

function classifyShellExecutionError(error: ShellExecutionError): { category: string; detail: string } {
  if (error.timedOut) return { category: "shell.timeout", detail: error.executor };
  if (error.interrupted) return { category: "shell.interrupted", detail: error.executor };
  const output = [error.stderr, error.stdout].filter(Boolean).join("\n");
  if (/here-document.*delimited by end-of-file/i.test(output)) {
    return { category: "shell.syntax.heredoc_unterminated", detail: error.executor };
  }
  if (/not a git repository/i.test(output)) return { category: "git.not_repository", detail: error.executor };
  const signature = output.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200) ?? "";
  return { category: "shell.exit.nonzero", detail: error.executor + ":" + error.code + ":" + signature };
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

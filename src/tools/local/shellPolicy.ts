import { ToolExecutionError, toolPolicyFailureResult } from "../errors.js";

export const SHELL_COMMAND_MAX_CHARS = 24_000;
export const SHELL_LARGE_INLINE_CONTENT_CHARS = 8_000;

export function shellToolPrompt(tool: "Bash" | "PowerShell"): string {
  return [
    "Use dedicated file tools instead of shell text commands:",
    "- Read files with Read, not cat/head/tail/Get-Content.",
    "- Edit existing files with Edit or MultiEdit, not sed/awk or shell string replacement.",
    "- Write files with Write, not echo redirection, cat heredocs, PowerShell here-strings, or large inline scripts.",
    "- If active project instructions require a specialized reader/writer, keep the shell invocation short and do not embed the file body in the command.",
    "- Send independent commands as separate tool calls. Chain commands only when later commands truly depend on earlier success.",
    "Large inline content is rejected because it is unreliable across shells and can exceed operating-system command-line limits.",
    "Tool: " + tool
  ].join("\n");
}

export function validateShellCommandInput(command: string, executor: "bash" | "powershell"): void {
  if (command.length > SHELL_COMMAND_MAX_CHARS) {
    throw new ToolExecutionError(
      "Shell command is too long. Use Read/Edit/MultiEdit/Write or a short command that consumes an existing file.",
      toolPolicyFailureResult("shell.input.command_too_long", "Shell command exceeds the 24000 character safety limit", executor)
    );
  }
  if (command.length >= SHELL_LARGE_INLINE_CONTENT_CHARS && hasInlineContentSyntax(command)) {
    throw new ToolExecutionError(
      "Large inline file or script content is not allowed. Use Read/Edit/MultiEdit/Write and keep shell commands short.",
      toolPolicyFailureResult("shell.input.large_inline_content", "Large heredoc, here-string, or triple-quoted inline content was rejected", executor)
    );
  }
}

export function shellCallMatchesFailureCategory(category: string, input: unknown): boolean {
  const command = shellCommand(input);
  if (!command) return false;
  if (
    category === "shell.input.command_too_long"
    || category === "shell.input.large_inline_content"
    || category === "shell.syntax.heredoc_unterminated"
    || category === "shell.spawn.command_too_long"
  ) {
    return hasInlineContentSyntax(command) || command.length >= SHELL_LARGE_INLINE_CONTENT_CHARS;
  }
  if (category === "git.not_repository") return /(^|[;&|]\s*|&&\s*)git\s+/m.test(command);
  return false;
}

export function isShellToolName(name: string): name is "Bash" | "PowerShell" {
  return name === "Bash" || name === "PowerShell";
}

function shellCommand(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

function hasInlineContentSyntax(command: string): boolean {
  return /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?|@["']|["']@|'''|"""/.test(command);
}

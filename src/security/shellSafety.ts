import { isDestructiveGitCommand } from "./gitSafety.js";

const destructiveShellPatterns = [
  /(^|[;&|\s])rm\s+(-[rfRiI]+\s+)?\S/i,
  /(^|[;&|\s])del\s+\S/i,
  /(^|[;&|\s])erase\s+\S/i,
  /(^|[;&|\s])rmdir\s+\S/i,
  /\bremove-item\b/i,
  /\bset-content\b/i,
  /\bout-file\b/i,
  /\bnew-item\b/i,
  /\bmove-item\b/i,
  /\bcopy-item\b/i,
  /(^|[;&|\s])tee\s+\S/i
];

export function isDestructiveShellCommand(input: unknown): boolean {
  const command = shellCommandText(input);
  return isDestructiveGitCommand(command)
    || hasShellRedirection(command)
    || destructiveShellPatterns.some((pattern) => pattern.test(command));
}

export function shellCommandText(input: unknown): string {
  return String((input as { command?: unknown }).command ?? "");
}

function hasShellRedirection(command: string): boolean {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const previous = command[index - 1];
    if (char === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (char === '"' && !singleQuoted && previous !== "\\") doubleQuoted = !doubleQuoted;
    if (char === ">" && !singleQuoted && !doubleQuoted) return true;
  }
  return false;
}

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

export function isReadOnlyShellCommand(input: unknown): boolean {
  const command = shellCommandText(input).trim();
  if (!command || isDestructiveShellCommand(input)) return false;
  const segments = splitTopLevelShellCommands(command);
  if (!segments?.length) return false;
  return segments.every((segment) => isReadOnlySimpleShellCommand(segment));
}

function isReadOnlySimpleShellCommand(command: string): boolean {
  if (!command || hasShellMetacharacter(command)) return false;
  const tokens = splitShellWords(command);
  if (!tokens.length) return false;
  const executable = commandName(tokens[0]);
  if (readOnlyCommands.has(executable)) return true;
  if (executable === "git") return isReadOnlyGitCommand(tokens.slice(1));
  if (executable === "find") return isReadOnlyFindCommand(tokens.slice(1));
  if (executable === "sed") return isReadOnlySedCommand(tokens.slice(1));
  if (executable === "command") return tokens[1] === "-v" && typeof tokens[2] === "string" && tokens.length === 3;
  return false;
}

export function isReadOnlyPowerShellCommand(input: unknown): boolean {
  const command = shellCommandText(input).trim();
  if (!command || isDestructiveShellCommand(input) || hasShellMetacharacter(command)) return false;
  const tokens = splitShellWords(command);
  if (!tokens.length) return false;
  const executable = commandName(tokens[0]).toLowerCase();
  if (readOnlyPowerShellCommands.has(executable)) return true;
  if (executable === "git") return isReadOnlyGitCommand(tokens.slice(1));
  return false;
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

function hasShellMetacharacter(command: string): boolean {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const previous = command[index - 1];
    if (char === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (char === "\"" && !singleQuoted && previous !== "\\") doubleQuoted = !doubleQuoted;
    if (singleQuoted || doubleQuoted) continue;
    if (char === "`" || char === "\n" || char === "\r") return true;
    if (char === "$" && command[index + 1] === "(") return true;
    if (";&|<>".includes(char)) return true;
  }
  return singleQuoted || doubleQuoted;
}

function splitTopLevelShellCommands(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const previous = command[index - 1];
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      current += char;
      continue;
    }
    if (char === "\"" && !singleQuoted && previous !== "\\") {
      doubleQuoted = !doubleQuoted;
      current += char;
      continue;
    }
    if (!singleQuoted && !doubleQuoted) {
      if (char === "`" || char === "\n" || char === "\r") return undefined;
      if (char === "$" && command[index + 1] === "(") return undefined;
      if (char === "<" || char === ">") return undefined;
      if (char === ";") {
        if (!pushShellSegment(segments, current)) return undefined;
        current = "";
        continue;
      }
      if (char === "&") {
        if (command[index + 1] !== "&") return undefined;
        if (!pushShellSegment(segments, current)) return undefined;
        current = "";
        index += 1;
        continue;
      }
      if (char === "|") {
        if (!pushShellSegment(segments, current)) return undefined;
        current = "";
        if (command[index + 1] === "|") index += 1;
        continue;
      }
    }
    current += char;
  }
  if (singleQuoted || doubleQuoted) return undefined;
  if (!pushShellSegment(segments, current)) return undefined;
  return segments;
}

function pushShellSegment(segments: string[], segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  segments.push(trimmed);
  return true;
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (char === "\"" && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (/\s/.test(char) && !singleQuoted && !doubleQuoted) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (singleQuoted || doubleQuoted) return [];
  if (current) words.push(current);
  return words;
}

function commandName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function isReadOnlyGitCommand(args: string[]): boolean {
  const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  return Boolean(subcommand && readOnlyGitSubcommands.has(subcommand));
}

function isReadOnlyFindCommand(args: string[]): boolean {
  return !args.some((arg) => destructiveFindArgs.has(arg.toLowerCase()));
}

function isReadOnlySedCommand(args: string[]): boolean {
  return !args.some((arg) => arg === "-i" || arg.startsWith("-i."));
}

const readOnlyCommands = new Set([
  "basename",
  "cat",
  "date",
  "dirname",
  "du",
  "egrep",
  "fgrep",
  "file",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "tree",
  "uname",
  "wc",
  "which",
  "whoami"
]);

const readOnlyPowerShellCommands = new Set([
  "get-childitem",
  "gci",
  "dir",
  "ls",
  "get-content",
  "gc",
  "cat",
  "get-location",
  "pwd",
  "resolve-path",
  "select-string"
]);

const readOnlyGitSubcommands = new Set([
  "branch",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status"
]);

const destructiveFindArgs = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"]);

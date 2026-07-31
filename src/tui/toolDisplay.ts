import stripAnsi from "strip-ansi";

export function sanitizeToolLogText(text: string): string {
  return stripAnsi(text);
}

export function getToolDisplayName(tool: string): string {
  if (tool === "LS") return "List";
  return tool;
}

export function getToolInputSummary(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") return readableValue(input);
  const value = input as Record<string, unknown>;

  if ((tool === "Bash" || tool === "PowerShell") && typeof value.command === "string") return value.command;
  if (tool === "AskUserQuestion" && Array.isArray(value.questions)) return `${value.questions.length} question${value.questions.length === 1 ? "" : "s"}`;
  if (tool === "TodoWrite" && Array.isArray(value.todos)) return `${value.todos.length} todos`;
  if (tool === "WebSearch" && typeof value.query === "string") return value.query;
  if (typeof value.path === "string") return value.path;
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.pattern === "string") return value.pattern;
  if (typeof value.url === "string") return value.url;
  if (typeof value.query === "string") return value.query;
  return readableRecord(value);
}

export function getToolInputDetail(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    if ((tool === "Bash" || tool === "PowerShell") && typeof value.command === "string") return `命令：${value.command}`;
    if (tool === "AskUserQuestion" && Array.isArray(value.questions)) return `问题：${value.questions.length} 个`;
    if (typeof value.path === "string") return `目标：${value.path}`;
    if (typeof value.file_path === "string") return `文件：${value.file_path}`;
    if (typeof value.pattern === "string") return `模式：${value.pattern}`;
    if (typeof value.url === "string") return `地址：${value.url}`;
    if (typeof value.query === "string") return `查询：${value.query}`;
    if (tool === "TodoWrite" && Array.isArray(value.todos)) return `待办：${value.todos.length} 项`;
    return readableRecord(value);
  }
  return readableValue(input);
}

export function getToolResultDetail(result: unknown): string {
  return formatToolResult(result, false);
}

export function getCompactToolResultDetail(result: unknown): string {
  return formatToolResult(result, true);
}

function formatToolResult(result: unknown, compact: boolean): string {
  if (!result || typeof result !== "object") return readableValue(result) || "(no output)";
  const value = result as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof value.output === "string") lines.push(value.output || "(no output)");
  if (typeof value.stderr === "string" && value.stderr) lines.push(value.stderr);
  if (typeof value.error === "string" && value.error) lines.push(`Error: ${value.error}`);
  if (typeof value.exit_code === "number" && value.exit_code !== 0) lines.push(`Exit code: ${value.exit_code}`);
  if (typeof value.path === "string") lines.push(value.path);
  const detail = lines.length ? lines.join("\n") : readableRecord(value) || "(no output)";
  return compact ? compactToolOutput(detail) : detail;
}

function compactToolOutput(output: string): string {
  const lines = output.split(/\r?\n/);
  if (output.endsWith("\n") && lines.at(-1) === "") lines.pop();
  const safeLines = lines.map((line) => truncate(line, 500));
  if (safeLines.length <= 5) return safeLines.join("\n");

  const omitted = safeLines.length - 4;
  return [...safeLines.slice(0, 2), `… +${omitted} lines (ctrl + o to view transcript)`, ...safeLines.slice(-2)].join("\n");
}

export function readableRecord(value: Record<string, unknown>): string {
  const lines = Object.entries(value).map(([key, item]) => `${key}：${readableValue(item)}`);
  return truncate(lines.join("\n"), 500);
}

export function readableValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "空";
  if (typeof value === "string") return truncate(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readableValue).join("、");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = ["text", "summary", "instruction", "request", "answer", "path", "file_path", "command", "pattern", "url", "query"];
    for (const key of preferred) {
      if (typeof record[key] === "string") return truncate(String(record[key]), 500);
    }
    return readableRecord(record);
  }
  return String(value);
}

const TRANSCRIPT_HINT = "ctrl + o to view transcript";

export function truncateToolDetail(text: string, max: number): string {
  if (text.length <= max) return text;
  if (!text.includes(TRANSCRIPT_HINT)) return truncate(text, max);

  const lines = text.split(/\r?\n/);
  const hintIndex = lines.findIndex((line) => line.includes(TRANSCRIPT_HINT));
  if (hintIndex === -1) return truncate(text, max);

  const preserved = lines.slice(hintIndex).join("\n");
  if (preserved.length >= max) return truncate(preserved, max);

  const prefixBudget = Math.max(0, max - preserved.length - 1);
  const prefix = truncate(lines.slice(0, hintIndex).join("\n"), prefixBudget);
  return prefix ? `${prefix}\n${preserved}` : preserved;
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

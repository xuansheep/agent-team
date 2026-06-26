import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

let logFilePath: string | undefined;

/**
 * Write a debug message to the agent-team debug log file.
 * Logs are written to the workspace's `.agent-team/logs/debug.log` file.
 * Respects the AGENT_TEAM_DEBUG environment variable to enable logging.
 * Also respects AGENT_TEAM_LOG_DIR to override the log directory.
 */
export function logForDebugging(
  message: string,
  options?: { level?: "debug" | "info" | "warn" | "error" }
): void {
  if (!process.env.AGENT_TEAM_DEBUG) return;

  if (!logFilePath) {
    const logDir =
      process.env.AGENT_TEAM_LOG_DIR ||
      join(process.cwd(), ".agent-team", "logs");
    if (!existsSync(logDir)) {
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        // If we can't create the directory, fall back to no-op
        return;
      }
    }
    logFilePath = join(logDir, "debug.log");
  }

  const level = options?.level ?? "debug";
  const timestamp = new Date().toISOString();
  const prefix = level === "error" ? "[ERR]" : level === "warn" ? "[WRN]" : level === "info" ? "[INF]" : "[DBG]";

  try {
    appendFileSync(logFilePath, `${timestamp} ${prefix} ${message}\n`);
  } catch {
    // Silently ignore write errors
  }
}

/**
 * Reset the log file. Creates a fresh file with a header.
 */
export function resetDebugLog(): void {
  logFilePath = undefined;
}

/**
 * Get the current debug log file path, if set.
 */
export function getDebugLogPath(): string | undefined {
  return logFilePath;
}

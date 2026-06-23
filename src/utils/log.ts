export function logError(error: unknown): void {
  if (process.env.AGENT_TEAM_DEBUG) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
  }
}

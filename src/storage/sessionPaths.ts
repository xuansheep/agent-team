import { createHash } from "node:crypto";
import { join } from "node:path";

export function getSessionSlug(sessionId: string): string {
  const normalized = sessionId.normalize("NFC");
  const safe = normalized.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 180);
  if (!safe || safe === "." || safe === "..") throw new Error(`Invalid session id ${JSON.stringify(sessionId)}`);
  if (safe === normalized) return safe;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${safe}-${hash}`;
}

export function planFilePathForSessionDir(sessionDir: string): string {
  return join(sessionDir, "plans", "plan.md");
}

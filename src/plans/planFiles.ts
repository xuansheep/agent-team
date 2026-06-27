import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export function getPlanSlug(sessionId: string): string {
  const safe = sessionId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "session";
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${safe}-${hash}`;
}

export function getPlanFilePath(sessionId: string, cwd = process.cwd(), plansDirectory = ".session/plans"): string {
  const directory = isAbsolute(plansDirectory) ? plansDirectory : join(cwd, plansDirectory);
  return join(directory, `${getPlanSlug(sessionId)}.md`);
}

export async function readPlan(planFilePath: string): Promise<string | undefined> {
  try {
    return await readFile(planFilePath, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writePlan(planFilePath: string, content: string): Promise<void> {
  await mkdir(dirname(planFilePath), { recursive: true });
  await writeFile(planFilePath, content, "utf8");
}

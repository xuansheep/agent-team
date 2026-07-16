import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getSessionSlug, planFilePathForSessionDir } from "../storage/sessionPaths.js";
import { sanitizeProjectPath } from "../storage/projectStorage.js";

const maxPlanSlugLength = 64;

export function getPlanSlug(sessionId: string): string {
  return getSessionSlug(sessionId);
}

export function getPlanFilePath(sessionId: string, cwd = process.cwd(), plansDirectory?: string, homeDir = process.env.EINSTEINS_HOME ?? homedir()): string {
  if (plansDirectory) {
    const directory = isAbsolute(plansDirectory) ? plansDirectory : join(cwd, plansDirectory);
    return join(directory, `${getPlanSlug(sessionId)}.md`);
  }
  const resolvedCwd = resolve(cwd);
  let projectPath = resolvedCwd;
  let current = resolvedCwd;
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      projectPath = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const projectDir = join(homeDir, ".einsteins", "projects", sanitizeProjectPath(projectPath));
  return planFilePathForSessionDir(join(projectDir, getSessionSlug(sessionId)));
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

export function planFilenameSlug(planContent: string | undefined, assistantContent?: string): string {
  const title = markdownTitle(planContent) ?? firstTextLine(assistantContent) ?? firstTextLine(planContent) ?? "plan";
  return slugifyPlanTitle(title);
}

export async function uniquePlanFilePath(currentPlanFilePath: string, slug: string): Promise<string> {
  const directory = dirname(currentPlanFilePath);
  const base = slugifyPlanTitle(slug);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = join(directory, `${base}${suffix}.md`);
    if (candidate === currentPlanFilePath || !(await fileExists(candidate))) return candidate;
  }
  return join(directory, `${base}-${Date.now()}.md`);
}

export function isDefaultPlanFilePath(planFilePath: string): boolean {
  return basename(planFilePath) === "plan.md";
}

function markdownTitle(content: string | undefined): string | undefined {
  if (!content) return undefined;
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function firstTextLine(content: string | undefined): string | undefined {
  if (!content) return undefined;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function slugifyPlanTitle(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, maxPlanSlugLength)
    .replace(/-+$/g, "");
  return ascii || "plan";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

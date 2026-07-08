import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import yaml from "js-yaml";
import { hooksSettingsSchema, type HooksSettings } from "../hooks/types.js";

export type SkillSource = "local" | "project" | "user" | "bundled" | "mcp";
export type SkillMode = "inline" | "fork" | "auto";

export type LoadedSkill = {
  name: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  model?: string;
  effort?: string;
  mode?: SkillMode;
  prompt: string;
  path: string;
  root: string;
  source: SkillSource;
  hooks?: HooksSettings;
  metadata?: Record<string, unknown>;
};

export async function loadLocalSkills(root: string): Promise<LoadedSkill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    const skillPath = entry.isDirectory() ? join(root, entry.name, "SKILL.md") : join(root, entry.name);
    if (!entry.isDirectory() && entry.name !== "SKILL.md") continue;
    if (!await exists(skillPath)) continue;
    skills.push(await loadSkillFile(skillPath));
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadSkillFile(path: string): Promise<LoadedSkill> {
  const raw = await readFile(path, "utf8");
  const parsed = parseSkillMarkdown(raw, path);
  return { ...parsed, path, root: dirname(path), source: "local" };
}

export function parseSkillMarkdown(raw: string, path = "SKILL.md"): Omit<LoadedSkill, "path" | "root" | "source"> {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatter) {
    return { name: basename(path, ".md"), prompt: raw };
  }
  const metadata = yaml.load(frontmatter[1]) as Record<string, unknown> | undefined;
  const prompt = raw.slice(frontmatter[0].length);
  const name = typeof metadata?.name === "string" && metadata.name.trim() ? metadata.name : basename(path, ".md");
  const description = typeof metadata?.description === "string" ? metadata.description : undefined;
  const whenToUse = typeof metadata?.when_to_use === "string" ? metadata.when_to_use : undefined;
  const allowedTools = stringArray(metadata?.["allowed-tools"] ?? metadata?.allowed_tools);
  const model = typeof metadata?.model === "string" ? metadata.model : undefined;
  const effort = typeof metadata?.effort === "string" ? metadata.effort : undefined;
  const mode = isSkillMode(metadata?.mode) ? metadata.mode : undefined;
  const hooks = metadata?.hooks === undefined ? undefined : hooksSettingsSchema.parse(metadata.hooks) as HooksSettings;
  return { name, description, whenToUse, allowedTools, model, effort, mode, prompt, hooks, metadata: metadata ?? {} };
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length ? strings : undefined;
}

function isSkillMode(value: unknown): value is SkillMode {
  return value === "inline" || value === "fork" || value === "auto";
}

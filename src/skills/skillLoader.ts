import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import yaml from "js-yaml";
import { hooksSettingsSchema, type HooksSettings } from "../hooks/types.js";

export type LoadedSkill = {
  name: string;
  description?: string;
  prompt: string;
  path: string;
  root: string;
  source: "local";
  hooks?: HooksSettings;
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
  const hooks = metadata?.hooks === undefined ? undefined : hooksSettingsSchema.parse(metadata.hooks) as HooksSettings;
  return { name, description, prompt, hooks };
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

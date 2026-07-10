import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import yaml from "js-yaml";

export type SkillSource = "local" | "project" | "user" | "managed" | "commands" | "bundled" | "mcp";
export type SkillMode = "inline" | "fork" | "auto";
export type SkillShell = "bash" | "powershell";

export type LoadedSkill = {
  name: string;
  displayName?: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  argumentHint?: string;
  argumentNames?: string[];
  version?: string;
  model?: string;
  effort?: string | number;
  mode?: SkillMode;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  paths?: string[];
  shell?: SkillShell;
  prompt: string;
  path: string;
  root: string;
  source: SkillSource;
  metadata?: Record<string, unknown>;
};

export type SkillLoadError = {
  path: string;
  error: string;
};

export type SkillDirectoryLoadResult = {
  skills: LoadedSkill[];
  errors: SkillLoadError[];
};

export async function loadLocalSkills(root: string): Promise<LoadedSkill[]> {
  return (await loadSkillsDirectory(root)).skills;
}

export async function loadSkillsDirectory(root: string, source: Exclude<SkillSource, "mcp"> = "local"): Promise<SkillDirectoryLoadResult> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { skills: [], errors: [] };
    return { skills: [], errors: [{ path: root, error: errorMessage(error) }] };
  }

  const skills: LoadedSkill[] = [];
  const errors: SkillLoadError[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    const skillPath = join(root, entry.name, "SKILL.md");
    try {
      if (!await isFile(skillPath)) return;
      skills.push(await loadSkillFile(skillPath, { source, name: entry.name }));
    } catch (error) {
      errors.push({ path: skillPath, error: errorMessage(error) });
    }
  }));
  skills.sort((left, right) => left.name.localeCompare(right.name));
  errors.sort((left, right) => left.path.localeCompare(right.path));
  return { skills, errors };
}

export async function loadSkillFile(
  path: string,
  options: { source?: SkillSource; name?: string; root?: string } = {}
): Promise<LoadedSkill> {
  const raw = await readFile(path, "utf8");
  const parsed = parseSkillMarkdown(raw, path);
  return {
    ...parsed,
    name: options.name ?? parsed.name,
    path,
    root: options.root ?? dirname(path),
    source: options.source ?? "local"
  };
}

export async function canonicalSkillPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export function parseSkillMarkdown(raw: string, path = "SKILL.md"): Omit<LoadedSkill, "path" | "root" | "source"> {
  const normalized = raw.replace(/^\uFEFF/, "");
  const frontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    return {
      name: fallbackName(path),
      userInvocable: true,
      disableModelInvocation: false,
      prompt: normalized,
      metadata: {}
    };
  }

  const loaded = yaml.load(frontmatter[1] ?? "");
  if (loaded !== undefined && (!loaded || typeof loaded !== "object" || Array.isArray(loaded))) {
    throw new Error(`Skill frontmatter in ${path} must be an object`);
  }
  const metadata = (loaded ?? {}) as Record<string, unknown>;
  const prompt = normalized.slice(frontmatter[0].length);
  const name = nonEmptyString(metadata.name) ?? fallbackName(path);
  const context = nonEmptyString(metadata.context);
  const legacyMode = nonEmptyString(metadata.mode);
  const mode: SkillMode | undefined = context === "fork"
    ? "fork"
    : isSkillMode(legacyMode) ? legacyMode : undefined;

  return {
    name,
    displayName: nonEmptyString(metadata.name),
    description: valueString(metadata.description),
    whenToUse: valueString(metadata.when_to_use ?? metadata["when-to-use"]),
    allowedTools: toolList(metadata["allowed-tools"] ?? metadata.allowed_tools),
    argumentHint: valueString(metadata["argument-hint"]),
    argumentNames: argumentNames(metadata.arguments),
    version: valueString(metadata.version),
    model: normalizedModel(metadata.model),
    effort: effortValue(metadata.effort),
    mode,
    userInvocable: booleanValue(metadata["user-invocable"], true),
    disableModelInvocation: booleanValue(metadata["disable-model-invocation"], false),
    paths: pathPatterns(metadata.paths),
    shell: skillShell(metadata.shell),
    prompt,
    metadata
  };
}

function fallbackName(path: string): string {
  return basename(path).toLowerCase() === "skill.md" ? basename(dirname(path)) : basename(path, ".md");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function valueString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function toolList(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : [value];
  const tools = parseToolList(values);
  const normalized = tools.includes("*") ? ["*"] : [...new Set(tools)];
  return normalized.length ? normalized : undefined;
}

function parseToolList(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    let current = "";
    let depth = 0;
    for (const character of value) {
      if (character === "(") depth += 1;
      if (character === ")") depth = Math.max(0, depth - 1);
      if ((character === "," || /\s/.test(character)) && depth === 0) {
        if (current.trim()) result.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    if (current.trim()) result.push(current.trim());
  }
  return result;
}

function argumentNames(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  const names = values.flatMap((item) => typeof item === "string" && item.trim() && !/^\d+$/.test(item.trim()) ? [item.trim()] : []);
  return names.length ? [...new Set(names)] : undefined;
}

function pathPatterns(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? splitCommaOutsideBraces(value) : [];
  const patterns = values.flatMap((item) => typeof item === "string" && item.trim() ? expandBraces(item.trim()) : [])
    .map((pattern) => pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern)
    .filter((pattern) => pattern && pattern !== "**");
  return patterns.length ? [...new Set(patterns)] : undefined;
}

function splitCommaOutsideBraces(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "{") depth += 1;
    if (character === "}") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function expandBraces(pattern: string): string[] {
  const match = /^([^{]*)\{([^}]+)\}(.*)$/.exec(pattern);
  if (!match) return [pattern];
  return match[2]!.split(",").flatMap((part) => expandBraces(`${match[1]}${part.trim()}${match[3]}`));
}

function normalizedModel(value: unknown): string | undefined {
  const model = nonEmptyString(value);
  return model === "inherit" ? undefined : model;
}

function effortValue(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).toLowerCase();
  if (["low", "medium", "high", "max"].includes(text)) return text;
  const numeric = Number.parseInt(text, 10);
  return Number.isInteger(numeric) ? numeric : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function skillShell(value: unknown): SkillShell | undefined {
  const shell = nonEmptyString(value)?.toLowerCase();
  return shell === "bash" || shell === "powershell" ? shell : undefined;
}

function isSkillMode(value: unknown): value is SkillMode {
  return value === "inline" || value === "fork" || value === "auto";
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
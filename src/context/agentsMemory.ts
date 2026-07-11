import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import yaml from "js-yaml";
import type { GlobalPromptMetadata, GlobalPromptSourceKind, GlobalPromptSourceMetadata } from "../config/schema.js";
import type { ResolvedAgentTeamSettings } from "../settings/types.js";

export type AgentsMemoryType = "Managed" | "User" | "Project" | "Local" | "Configured";

export type AgentsMemoryFile = {
  path: string;
  type: AgentsMemoryType;
  content: string;
  sourceKind?: GlobalPromptSourceKind;
  parent?: string;
  globs?: string[];
};

export type AgentsMemoryLoadOptions = {
  cwd: string;
  configDir?: string;
  homeDir?: string;
  configuredPromptFile?: string;
  settings?: ResolvedAgentTeamSettings;
  includeExternal?: boolean;
};

type ParsedMemoryFile = {
  file?: AgentsMemoryFile;
  includePaths: string[];
};

const memoryInstructionPrompt =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";
const maxIncludeDepth = 5;
const textExtensions = new Set([
  ".md", ".txt", ".text", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".cs", ".swift", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".env", ".ini", ".cfg", ".conf", ".config", ".properties", ".sql", ".graphql", ".gql", ".proto", ".vue", ".svelte",
  ".astro", ".ejs", ".hbs", ".pug", ".php", ".pl", ".pm", ".lua", ".r", ".dart", ".ex", ".exs", ".erl", ".hrl",
  ".clj", ".cljs", ".cljc", ".edn", ".hs", ".lhs", ".elm", ".ml", ".mli", ".cmake", ".make", ".makefile", ".gradle",
  ".sbt", ".rst", ".adoc", ".asciidoc", ".org", ".tex", ".latex", ".lock", ".log", ".diff", ".patch"
]);

export async function getAgentsMemoryFiles(options: AgentsMemoryLoadOptions): Promise<AgentsMemoryFile[]> {
  const cwd = resolve(options.cwd);
  const configDir = resolve(options.configDir ?? cwd);
  const includeExternal = options.includeExternal ?? options.settings?.hasAgentsMdExternalIncludesApproved ?? false;
  const processed = new Set<string>();
  const files: AgentsMemoryFile[] = [];

  files.push(...await processAgentsMemoryFile(managedAgentsPath(), "Managed", processed, cwd, true, options.settings));
  files.push(...await processAgentsMemoryFile(join(options.homeDir ?? homedir(), ".einsteins", "AGENTS.md"), "User", processed, cwd, true, options.settings));

  for (const dir of projectDirsFromRoot(cwd)) {
    files.push(...await processAgentsMemoryFile(join(dir, "AGENTS.md"), "Project", processed, cwd, includeExternal, options.settings));
    files.push(...await processAgentsMemoryFile(join(dir, ".einsteins", "AGENTS.md"), "Project", processed, cwd, includeExternal, options.settings));
    files.push(...await processAgentsRules(join(dir, ".einsteins", "rules"), "Project", processed, cwd, includeExternal, false, undefined, options.settings));
    files.push(...await processAgentsMemoryFile(join(dir, "AGENTS.local.md"), "Local", processed, cwd, includeExternal, options.settings));
  }

  const configured = await configuredMemory(options, configDir, processed, cwd, includeExternal);
  if (configured) files.push(...configured);
  return files.filter((file) => file.content.trim());
}

export function getAgentsPrompt(files: AgentsMemoryFile[]): string | undefined {
  const entries = files.flatMap((file) => {
    const content = file.content.trim();
    if (!content) return [];
    return [`Contents of ${file.path}${memoryDescription(file.type)}:\n\n${content}`];
  });
  return entries.length ? `${memoryInstructionPrompt}\n\n${entries.join("\n\n")}` : undefined;
}

export function agentsMemoryMetadata(prompt: string, files: AgentsMemoryFile[]): GlobalPromptMetadata {
  return {
    ...promptTextSummary(prompt),
    sources: files.map((file) => ({
      kind: file.sourceKind ?? sourceKind(file.type),
      path: file.path,
      ...promptTextSummary(file.content)
    }))
  };
}

export function getExternalAgentsMdIncludes(files: AgentsMemoryFile[], cwd: string): Array<{ path: string; parent: string }> {
  const root = resolve(cwd);
  return files.flatMap((file) => file.type !== "User" && file.parent && !isInsideOrSame(root, resolve(file.path))
    ? [{ path: file.path, parent: file.parent }]
    : []);
}

export async function hasExternalAgentsMdIncludes(options: AgentsMemoryLoadOptions): Promise<boolean> {
  return getExternalAgentsMdIncludes(await getAgentsMemoryFiles({ ...options, includeExternal: true }), options.cwd).length > 0;
}

async function processAgentsMemoryFile(
  path: string,
  type: AgentsMemoryType,
  processed: Set<string>,
  cwd: string,
  includeExternal: boolean,
  settings: ResolvedAgentTeamSettings | undefined,
  depth = 0,
  parent?: string
): Promise<AgentsMemoryFile[]> {
  const normalized = await normalizedPath(path);
  if (processed.has(normalized) || depth >= maxIncludeDepth || isAgentsMdExcluded(path, type, settings)) return [];
  const parsed = await readMemoryFile(path, type, parent ? undefined : path);
  if (!parsed.file) return [];
  processed.add(normalized);

  const included: AgentsMemoryFile[] = [];
  for (const includePath of parsed.includePaths) {
    if (!includeExternal && !isInsideOrSame(resolve(cwd), includePath)) continue;
    included.push(...await processAgentsMemoryFile(includePath, type, processed, cwd, includeExternal, settings, depth + 1, path));
  }
  return [...included, { ...parsed.file, parent }];
}

async function processAgentsRules(
  rulesDir: string,
  type: AgentsMemoryType,
  processed: Set<string>,
  cwd: string,
  includeExternal: boolean,
  conditional: boolean,
  targetPath: string | undefined,
  settings: ResolvedAgentTeamSettings | undefined
): Promise<AgentsMemoryFile[]> {
  let paths: string[];
  try {
    paths = (await fg("**/*.md", { cwd: rulesDir, absolute: true, dot: true, onlyFiles: true })).sort();
  } catch {
    return [];
  }
  const files: AgentsMemoryFile[] = [];
  for (const path of paths) {
    const processedFiles = await processAgentsMemoryFile(path, type, processed, cwd, includeExternal, settings);
    for (const file of processedFiles) {
      const hasGlobs = Boolean(file.globs?.length);
      if (conditional !== hasGlobs) continue;
      if (conditional && targetPath && !matchesAnyGlob(relative(dirname(dirname(rulesDir)), targetPath), file.globs ?? [])) continue;
      files.push(file);
    }
  }
  return files;
}

async function readMemoryFile(path: string, type: AgentsMemoryType, includeBasePath?: string): Promise<ParsedMemoryFile> {
  try {
    if (!isTextFile(path)) return { includePaths: [] };
    const raw = await readFile(path, "utf8");
    const parsed = parseFrontmatter(raw);
    const content = stripBlockHtmlComments(parsed.content);
    return {
      file: { path, type, content, globs: parsed.paths },
      includePaths: includeBasePath ? extractIncludePaths(content, includeBasePath) : []
    };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "EISDIR") return { includePaths: [] };
    throw error;
  }
}

async function configuredMemory(
  options: AgentsMemoryLoadOptions,
  configDir: string,
  processed: Set<string>,
  cwd: string,
  includeExternal: boolean
): Promise<AgentsMemoryFile[] | undefined> {
  if (options.configuredPromptFile) {
    return processAgentsMemoryFile(resolve(configDir, options.configuredPromptFile), "Configured", processed, cwd, includeExternal, options.settings);
  }
  return undefined;
}

function parseFrontmatter(raw: string): { content: string; paths?: string[] } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { content: raw };
  const metadata = yaml.load(match[1] ?? "") as { paths?: unknown } | undefined;
  const paths = frontmatterPaths(metadata?.paths);
  return { content: raw.slice(match[0].length), ...(paths.length ? { paths } : {}) };
}

function frontmatterPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
  if (typeof value === "string") return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function extractIncludePaths(content: string, basePath: string): string[] {
  const paths = new Set<string>();
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const regex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const raw = (match[1] ?? "").split("#")[0]?.replace(/\\ /g, " ").trim();
      if (!raw || raw.startsWith("@") || /^[#%^&*()]+/.test(raw)) continue;
      if (!raw.startsWith("./") && !raw.startsWith("~/") && !raw.startsWith("/") && !/^[a-zA-Z0-9._-]/.test(raw)) continue;
      paths.add(expandIncludePath(raw, dirname(basePath)));
    }
  }
  return [...paths];
}

function expandIncludePath(path: string, baseDir: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return resolve(baseDir, path);
}

function stripBlockHtmlComments(content: string): string {
  return content.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n)?/gm, "");
}

function projectDirsFromRoot(cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    dirs.unshift(current);
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function managedAgentsPath(): string {
  if (process.env.AGENT_TEAM_MANAGED_AGENTS_MD) return resolve(process.env.AGENT_TEAM_MANAGED_AGENTS_MD);
  return platform() === "win32" ? "C:\\ProgramData\\agent-team\\AGENTS.md" : "/etc/agent-team/AGENTS.md";
}

function isAgentsMdExcluded(path: string, type: AgentsMemoryType, settings: ResolvedAgentTeamSettings | undefined): boolean {
  if (type !== "User" && type !== "Project" && type !== "Local") return false;
  const patterns = settings?.agentsMdExcludes ?? [];
  if (!patterns.length) return false;
  const normalized = path.replaceAll("\\", "/");
  return patterns.some((pattern) => matchesGlob(normalized, pattern.replaceAll("\\", "/")));
}

function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return !ext || textExtensions.has(ext);
}

function memoryDescription(type: AgentsMemoryType): string {
  if (type === "Project") return " (project instructions, checked into the codebase)";
  if (type === "Local") return " (user's private project instructions, not checked in)";
  if (type === "Managed") return " (managed instructions for all users)";
  if (type === "Configured") return " (configured instructions)";
  return " (user's private global instructions for all projects)";
}

function sourceKind(type: AgentsMemoryType): GlobalPromptSourceKind {
  if (type === "User") return "user_agents";
  if (type === "Project") return "project_agents";
  if (type === "Local") return "local_agents";
  if (type === "Managed") return "managed_agents";
  return "configured_file";
}

function promptTextSummary(content: string): { sha256: string; chars: number; lines: number } {
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    chars: content.length,
    lines: content ? content.split(/\r?\n/).length : 0
  };
}

async function normalizedPath(path: string): Promise<string> {
  try {
    return (await realpath(path)).toLowerCase();
  } catch {
    return resolve(path).toLowerCase();
  }
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  const normalized = path.replaceAll("\\", "/");
  return globs.some((glob) => matchesGlob(normalized, glob));
}

function matchesGlob(path: string, pattern: string): boolean {
  const regex = globToRegExp(pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern) ? pattern : `**/${pattern}`);
  return regex.test(path);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function isInsideOrSame(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

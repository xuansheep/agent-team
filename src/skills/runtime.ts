import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import type { ModelMessage, ModelProvider } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/types.js";
import {
  canonicalSkillPath,
  loadSkillFile,
  loadSkillsDirectory,
  type LoadedSkill,
  type SkillLoadError,
  type SkillMode,
  type SkillSource
} from "./skillLoader.js";

export type SkillRuntimeDiscoverOptions = {
  cwd: string;
  explicitProjectSkillPaths?: string[];
  userSkillRoot?: string;
  managedSkillRoot?: string;
  bundledSkillRoots?: string[];
  bundledSkills?: LoadedSkill[];
  commandRoots?: string[];
  mcpSkills?: LoadedSkill[] | (() => Promise<LoadedSkill[]>);
};

export type SkillActivationOptions = {
  mode?: SkillMode;
  messages?: ModelMessage[];
  prompt?: string;
  args?: string;
  provider?: ModelProvider;
  model?: string;
  tools?: ToolRegistry;
  cwd?: string;
  sessionId?: string;
  parentPermissionMode?: "default" | "fullAccess" | "plan";
  signal?: AbortSignal;
};

export type SkillActivationResult =
  | { mode: "inline"; skill: LoadedSkill; messages: ModelMessage[]; renderedPrompt: string }
  | { mode: "fork"; skill: LoadedSkill; output: string; permissionMode?: SkillActivationOptions["parentPermissionMode"] };

export type SkillRuntimeDiagnostic = {
  name: string;
  source: LoadedSkill["source"];
  mode: SkillMode;
  path: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  argumentHint?: string;
  version?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  paths?: string[];
  error?: string;
};

type SkillSourceRoot = { root: string; source: Exclude<SkillSource, "mcp">; kind?: "skills" | "commands" };
type DiscoveryResult = { skills: LoadedSkill[]; errors: Array<SkillLoadError & { source: Exclude<SkillSource, "mcp"> }> };

export class SkillRuntime {
  private skills: LoadedSkill[] = [];
  private skillByName = new Map<string, LoadedSkill>();
  private conditionalByName = new Map<string, LoadedSkill>();
  private errors: Array<SkillLoadError & { source: Exclude<SkillSource, "mcp"> }> = [];
  private readonly activatedConditionalNames = new Set<string>();
  private readonly activatedBySession = new Map<string, Set<string>>();

  constructor(skills: LoadedSkill[], private readonly discoverOptions?: SkillRuntimeDiscoverOptions, errors: Array<SkillLoadError & { source: Exclude<SkillSource, "mcp"> }> = []) {
    this.replaceSkills(skills, errors);
  }

  static async discover(options: SkillRuntimeDiscoverOptions): Promise<SkillRuntime> {
    const result = await discoverSkills(options);
    return new SkillRuntime(result.skills, options, result.errors);
  }

  async refresh(): Promise<void> {
    if (!this.discoverOptions) return;
    const result = await discoverSkills(this.discoverOptions);
    this.replaceSkills(result.skills, result.errors);
  }

  listSkills(input: { includeHidden?: boolean; includeConditional?: boolean } = {}): LoadedSkill[] {
    const visible = input.includeConditional ? this.skills : this.skills.filter((skill) => !skill.paths?.length || this.activatedConditionalNames.has(skill.name));
    return visible.filter((skill) => input.includeHidden || skill.userInvocable !== false).slice();
  }

  listModelInvocableSkills(): LoadedSkill[] {
    return this.skills.filter((skill) => (!skill.paths?.length || this.activatedConditionalNames.has(skill.name)) && skill.disableModelInvocation !== true);
  }

  getSkill(name: string): LoadedSkill | undefined {
    const skill = this.skillByName.get(stripLeadingSlash(name));
    if (!skill?.paths?.length || this.activatedConditionalNames.has(skill.name)) return skill;
    return undefined;
  }

  getDiagnostics(): SkillRuntimeDiagnostic[] {
    const skills = this.skills.map((skill) => ({
      name: skill.name,
      source: skill.source,
      mode: skill.mode ?? "inline" as SkillMode,
      path: skill.path,
      description: skill.description,
      whenToUse: skill.whenToUse,
      allowedTools: skill.allowedTools,
      argumentHint: skill.argumentHint,
      version: skill.version,
      userInvocable: skill.userInvocable,
      disableModelInvocation: skill.disableModelInvocation,
      paths: skill.paths
    }));
    const errors = this.errors.map((error) => ({
      name: `<invalid:${basename(dirname(error.path))}>`,
      source: error.source,
      mode: "inline" as const,
      path: error.path,
      error: error.error
    }));
    return [...skills, ...errors];
  }

  activateForPaths(paths: string[], cwd = this.discoverOptions?.cwd ?? process.cwd()): string[] {
    const activated: string[] = [];
    for (const skill of this.conditionalByName.values()) {
      if (this.activatedConditionalNames.has(skill.name)) continue;
      if (!paths.some((path) => matchesAnySkillPath(path, cwd, skill.paths ?? []))) continue;
      this.activatedConditionalNames.add(skill.name);
      activated.push(skill.name);
    }
    return activated;
  }

  getActivatedSkillNames(sessionId: string): string[] {
    return [...(this.activatedBySession.get(sessionId) ?? [])].sort();
  }

  restoreSession(sessionId: string, skillNames: string[]): void {
    const names = new Set(skillNames.filter((name) => this.skillByName.has(name)));
    this.activatedBySession.set(sessionId, names);
    for (const name of names) if (this.conditionalByName.has(name)) this.activatedConditionalNames.add(name);
  }

  skillRequiresShell(name: string): boolean {
    const skill = this.getSkill(name);
    return Boolean(skill && skill.source !== "mcp" && hasShellExpansion(skill.prompt));
  }

  async activateSkill(name: string, options: SkillActivationOptions = {}): Promise<SkillActivationResult> {
    const skill = this.requireSkill(name);
    const renderedPrompt = await renderSkillPrompt(skill, options);
    const sessionId = options.sessionId ?? "global";
    const activated = this.activatedBySession.get(sessionId) ?? new Set<string>();
    activated.add(skill.name);
    this.activatedBySession.set(sessionId, activated);

    const mode = resolveMode(skill, options.mode);
    if (mode === "inline") {
      return {
        mode,
        skill,
        renderedPrompt,
        messages: [...(options.messages ?? []), skillSystemMessage(skill, renderedPrompt)]
      };
    }
    return this.activateForkSkill(skill, renderedPrompt, options);
  }

  private async activateForkSkill(skill: LoadedSkill, renderedPrompt: string, options: SkillActivationOptions): Promise<SkillActivationResult> {
    if (!options.provider) throw new Error(`Fork skill ${skill.name} requires a model provider`);
    const model = skill.model ?? options.model;
    if (!model) throw new Error(`Fork skill ${skill.name} requires a model`);
    const response = await options.provider.generate({
      model,
      effort: skill.effort,
      messages: [skillSystemMessage(skill, renderedPrompt), { role: "user", content: options.prompt ?? options.args ?? "" }],
      tools: narrowedTools(options.tools, skill.allowedTools),
      context: options.sessionId ? { sessionId: options.sessionId, runId: options.sessionId, nodeId: `skill:${skill.name}`, attempt: 1, threadId: options.sessionId, turnId: `${options.sessionId}:skill:${skill.name}`, promptCacheKey: options.sessionId } : undefined,
      signal: options.signal
    });
    return { mode: "fork", skill, output: response.content ?? "", permissionMode: options.parentPermissionMode };
  }

  private requireSkill(name: string): LoadedSkill {
    const normalized = stripLeadingSlash(name);
    const skill = this.getSkill(normalized);
    if (!skill) throw new Error(`Unknown or inactive skill ${normalized}`);
    return skill;
  }

  private replaceSkills(skills: LoadedSkill[], errors: Array<SkillLoadError & { source: Exclude<SkillSource, "mcp"> }>): void {
    this.skills = skills.slice().sort((left, right) => left.name.localeCompare(right.name));
    this.skillByName = new Map(this.skills.map((skill) => [skill.name, skill]));
    this.conditionalByName = new Map(this.skills.filter((skill) => skill.paths?.length).map((skill) => [skill.name, skill]));
    this.errors = errors.slice();
    for (const name of [...this.activatedConditionalNames]) if (!this.conditionalByName.has(name)) this.activatedConditionalNames.delete(name);
  }
}

export function defaultUserSkillRoot(): string {
  return join(homedir(), ".einsteins", "skills");
}

export function defaultManagedSkillRoot(): string {
  const managedRoot = process.env.AGENT_TEAM_MANAGED_DIR
    ?? (platform() === "win32" ? join(process.env.ProgramData ?? "C:\\ProgramData", "agent-team") : "/etc/agent-team");
  return join(managedRoot, ".einsteins", "skills");
}

async function discoverSkills(options: SkillRuntimeDiscoverOptions): Promise<DiscoveryResult> {
  const explicitPaths = options.explicitProjectSkillPaths ?? [];
  const roots: SkillSourceRoot[] = [
    { root: options.managedSkillRoot ?? defaultManagedSkillRoot(), source: "managed" },
    { root: options.userSkillRoot ?? defaultUserSkillRoot(), source: "user" },
    ...projectDirectories(options.cwd).map((directory) => ({ root: join(directory, ".einsteins", "skills"), source: "project" as const })),
    ...explicitPaths.map((root) => ({ root, source: "project" as const })),
    ...(options.commandRoots ?? defaultCommandRoots(options.cwd)).map((root) => ({ root, source: "commands" as const, kind: "commands" as const })),
    ...(options.bundledSkillRoots ?? []).map((root) => ({ root, source: "bundled" as const }))
  ];

  const discovered = new Map<string, LoadedSkill>();
  const seenPaths = new Set<string>();
  const errors: Array<SkillLoadError & { source: Exclude<SkillSource, "mcp"> }> = [];
  for (const root of roots) {
    const result = root.kind === "commands" ? await loadCommands(root.root) : await loadSkillsPath(root.root, root.source);
    errors.push(...result.errors.map((error) => ({ ...error, source: root.source })));
    for (const skill of result.skills) await addSkill(discovered, seenPaths, { ...skill, source: root.source });
  }
  for (const skill of options.bundledSkills ?? []) await addSkill(discovered, seenPaths, { ...skill, source: "bundled" });
  const mcpSkills = typeof options.mcpSkills === "function" ? await options.mcpSkills() : options.mcpSkills ?? [];
  for (const skill of mcpSkills) if (!discovered.has(skill.name)) discovered.set(skill.name, { ...skill, source: "mcp" });
  return { skills: [...discovered.values()], errors };
}

async function addSkill(target: Map<string, LoadedSkill>, seenPaths: Set<string>, skill: LoadedSkill): Promise<void> {
  if (target.has(skill.name)) return;
  if (skill.source !== "mcp") {
    const identity = await canonicalSkillPath(skill.path);
    if (identity && seenPaths.has(identity.toLowerCase())) return;
    if (identity) seenPaths.add(identity.toLowerCase());
  }
  target.set(skill.name, skill);
}

async function loadSkillsPath(path: string, source: Exclude<SkillSource, "mcp">): Promise<{ skills: LoadedSkill[]; errors: SkillLoadError[] }> {
  const kind = await pathKind(path);
  if (!kind) return { skills: [], errors: [] };
  if (kind === "file") {
    try {
      return { skills: [await loadSkillFile(path, { source })], errors: [] };
    } catch (error) {
      return { skills: [], errors: [{ path, error: errorMessage(error) }] };
    }
  }
  const directSkill = join(path, "SKILL.md");
  if (await pathKind(directSkill) === "file") {
    try {
      return { skills: [await loadSkillFile(directSkill, { source, name: basename(path), root: path })], errors: [] };
    } catch (error) {
      return { skills: [], errors: [{ path: directSkill, error: errorMessage(error) }] };
    }
  }
  return loadSkillsDirectory(path, source);
}

async function loadCommands(root: string): Promise<{ skills: LoadedSkill[]; errors: SkillLoadError[] }> {
  let files: string[];
  try {
    files = (await fg("**/*.md", { cwd: root, absolute: true, onlyFiles: true, dot: true })).sort();
  } catch (error) {
    return { skills: [], errors: [{ path: root, error: errorMessage(error) }] };
  }
  const skillFileDirectories = new Set(files.filter((file) => basename(file).toLowerCase() === "skill.md").map(dirname));
  const skills: LoadedSkill[] = [];
  const errors: SkillLoadError[] = [];
  for (const file of files) {
    if (basename(file).toLowerCase() !== "skill.md" && skillFileDirectories.has(dirname(file))) continue;
    const relativePath = relative(root, file);
    const isSkillFile = basename(file).toLowerCase() === "skill.md";
    const parts = (isSkillFile ? dirname(relativePath) : relativePath.slice(0, -3)).split(/[\\/]+/).filter((part) => part && part !== ".");
    const name = parts.join(":") || basename(dirname(file));
    try {
      skills.push(await loadSkillFile(file, { source: "commands", name, root: isSkillFile ? dirname(file) : root }));
    } catch (error) {
      errors.push({ path: file, error: errorMessage(error) });
    }
  }
  return { skills, errors };
}

function defaultCommandRoots(cwd: string): string[] {
  return [join(homedir(), ".einsteins", "commands"), ...projectDirectories(cwd).map((directory) => join(directory, ".einsteins", "commands"))];
}

function projectDirectories(cwd: string): string[] {
  const home = resolve(homedir()).toLowerCase();
  const directories: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    if (current.toLowerCase() === home) break;
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

async function pathKind(path: string): Promise<"file" | "directory" | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function resolveMode(skill: LoadedSkill, requested: SkillMode | undefined): "inline" | "fork" {
  const mode = requested ?? skill.mode ?? "inline";
  return mode === "auto" ? (skill.mode === "fork" ? "fork" : "inline") : mode;
}

async function renderSkillPrompt(skill: LoadedSkill, options: SkillActivationOptions): Promise<string> {
  let content = skill.source === "mcp" ? skill.prompt : `Base directory for this skill: ${normalizedSkillRoot(skill.root)}\n\n${skill.prompt}`;
  content = substituteArguments(content, options.args, skill.argumentNames ?? []);
  content = content.replace(/\$\{EINSTEINS_SKILL_DIR\}/g, normalizedSkillRoot(skill.root));
  content = content.replace(/\$\{EINSTEINS_SESSION_ID\}/g, options.sessionId ?? "global");
  if (skill.source !== "mcp") content = await executeShellExpansions(content, skill, options);
  return content;
}

function substituteArguments(content: string, args: string | undefined, names: string[]): string {
  if (args === undefined) return content;
  const values = parseArguments(args);
  const original = content;
  names.forEach((name, index) => { content = content.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, "g"), values[index] ?? ""); });
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index) => values[Number(index)] ?? "");
  content = content.replace(/\$(\d+)(?!\w)/g, (_match, index) => values[Number(index)] ?? "");
  content = content.replaceAll("$ARGUMENTS", args);
  if (content === original && args) content += `\n\nARGUMENTS: ${args}`;
  return content;
}

function parseArguments(args: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) values.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"])/g, "$1"));
  return values;
}

async function executeShellExpansions(content: string, skill: LoadedSkill, options: SkillActivationOptions): Promise<string> {
  const matches = [...content.matchAll(/```!\s*\r?\n?([\s\S]*?)\r?\n?```/g), ...content.matchAll(/(?:^|\s)!`([^`]+)`/gm)]
    .filter((match) => match.index !== undefined)
    .sort((left, right) => right.index! - left.index!);
  if (!matches.length) return content;
  if (!options.tools) throw new Error(`Skill ${skill.name} contains shell expansion but no tool registry is available`);
  const toolName = skill.shell === "powershell" ? "PowerShell" : "Bash";
  const tool = options.tools.get(toolName);
  let result = content;
  for (const match of matches) {
    const command = match[1]?.trim();
    if (!command) continue;
    const execution = await tool.execute({ command }, {
      cwd: options.cwd ?? process.cwd(),
      sessionId: options.sessionId,
      abortSignal: options.signal
    });
    if (execution.error || execution.exit_code && execution.exit_code !== 0) throw new Error(execution.error ?? `${toolName} exited with ${execution.exit_code}`);
    result = `${result.slice(0, match.index!)}${execution.output ?? ""}${result.slice(match.index! + match[0].length)}`;
  }
  return result;
}

function hasShellExpansion(content: string): boolean {
  return /```!|(?:^|\s)!`/m.test(content);
}

function skillSystemMessage(skill: LoadedSkill, prompt: string): ModelMessage {
  return { role: "system", content: `SKILL ${skill.name}\n\n${prompt.trim()}` };
}

function narrowedTools(registry: ToolRegistry | undefined, allowedTools: string[] | undefined): Tool[] {
  if (!registry) return [];
  const tools = registry.list();
  if (!allowedTools?.length || allowedTools.includes("*")) return tools;
  const allowed = new Set(allowedTools.map((entry) => entry.replace(/\(.*/, "")));
  return tools.filter((tool) => allowed.has(tool.name));
}

function normalizedSkillRoot(root: string): string {
  return platform() === "win32" ? root.replaceAll("\\", "/") : root;
}

function matchesAnySkillPath(path: string, cwd: string, patterns: string[]): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const relativePath = relative(cwd, absolute).replaceAll("\\", "/");
  return patterns.some((pattern) => globToRegExp(pattern.replaceAll("\\", "/")).test(relativePath));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") { source += ".*"; index += 1; }
    else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapeRegExp(character);
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function stripLeadingSlash(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

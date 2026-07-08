import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import type { HookRuntime } from "../hooks/runtime.js";
import { registerSkillHooks as registerHooksFromSkill } from "../hooks/runtime.js";
import type { ModelMessage, ModelProvider } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { loadLocalSkills, loadSkillFile, type LoadedSkill, type SkillMode, type SkillSource } from "./skillLoader.js";

export type SkillRuntimeDiscoverOptions = {
  cwd: string;
  explicitProjectSkillPaths?: string[];
  userSkillRoot?: string;
  bundledSkillRoots?: string[];
  mcpSkills?: LoadedSkill[] | (() => Promise<LoadedSkill[]>);
};

export type SkillActivationOptions = {
  mode?: SkillMode;
  messages?: ModelMessage[];
  prompt?: string;
  provider?: ModelProvider;
  model?: string;
  tools?: ToolRegistry;
  hookRuntime?: HookRuntime;
  parentPermissionMode?: "default" | "fullAccess" | "plan";
  signal?: AbortSignal;
};

export type SkillActivationResult =
  | {
      mode: "inline";
      skill: LoadedSkill;
      messages: ModelMessage[];
      hookIds: string[];
    }
  | {
      mode: "fork";
      skill: LoadedSkill;
      output: string;
      hookIds: string[];
      permissionMode?: SkillActivationOptions["parentPermissionMode"];
    };

type SkillSourceRoot = {
  root: string;
  source: Exclude<SkillSource, "mcp">;
};

export class SkillRuntime {
  private readonly skills: LoadedSkill[];
  private readonly skillByName: Map<string, LoadedSkill>;

  constructor(skills: LoadedSkill[]) {
    this.skills = skills.slice().sort((left, right) => left.name.localeCompare(right.name));
    this.skillByName = new Map(this.skills.map((skill) => [skill.name, skill]));
  }

  static async discover(options: SkillRuntimeDiscoverOptions): Promise<SkillRuntime> {
    const discovered = new Map<string, LoadedSkill>();
    const roots: SkillSourceRoot[] = [
      ...(options.explicitProjectSkillPaths ?? []).map((root) => ({ root, source: "project" as const })),
      { root: join(options.cwd, ".agents", "skills"), source: "project" },
      { root: join(options.cwd, ".einsteins", "skills"), source: "project" },
      { root: options.userSkillRoot ?? defaultUserSkillRoot(), source: "user" },
      ...(options.bundledSkillRoots ?? []).map((root) => ({ root, source: "bundled" as const }))
    ];

    for (const sourceRoot of roots) {
      for (const skill of await loadSkillsFromPath(sourceRoot.root, sourceRoot.source)) {
        if (!discovered.has(skill.name)) discovered.set(skill.name, skill);
      }
    }

    const mcpSkills = typeof options.mcpSkills === "function" ? await options.mcpSkills() : options.mcpSkills ?? [];
    for (const skill of mcpSkills) {
      if (!discovered.has(skill.name)) discovered.set(skill.name, { ...skill, source: "mcp" });
    }

    return new SkillRuntime([...discovered.values()]);
  }

  listSkills(): LoadedSkill[] {
    return this.skills.slice();
  }

  getSkill(name: string): LoadedSkill | undefined {
    return this.skillByName.get(name);
  }

  async activateSkill(name: string, options: SkillActivationOptions = {}): Promise<SkillActivationResult> {
    const skill = this.requireSkill(name);
    const mode = resolveMode(skill, options.mode);
    const hookIds = registerSkillHooks(options.hookRuntime, skill);
    if (mode === "inline") {
      return {
        mode,
        skill,
        hookIds,
        messages: [...(options.messages ?? []), skillSystemMessage(skill)]
      };
    }
    return this.activateForkSkill(skill, options, hookIds);
  }

  private async activateForkSkill(skill: LoadedSkill, options: SkillActivationOptions, hookIds: string[]): Promise<SkillActivationResult> {
    if (!options.provider) throw new Error(`Fork skill ${skill.name} requires a model provider`);
    const model = skill.model ?? options.model;
    if (!model) throw new Error(`Fork skill ${skill.name} requires a model`);
    const response = await options.provider.generate({
      model,
      messages: [
        skillSystemMessage(skill),
        { role: "user", content: options.prompt ?? "" }
      ],
      tools: narrowedTools(options.tools, skill.allowedTools),
      signal: options.signal
    });
    return {
      mode: "fork",
      skill,
      output: response.content ?? "",
      hookIds,
      permissionMode: options.parentPermissionMode
    };
  }

  private requireSkill(name: string): LoadedSkill {
    const skill = this.skillByName.get(name);
    if (!skill) throw new Error(`Unknown skill ${name}`);
    return skill;
  }
}

export function defaultUserSkillRoot(): string {
  return join(homedir(), ".einsteins", "skills");
}

async function loadSkillsFromPath(path: string, source: Exclude<SkillSource, "mcp">): Promise<LoadedSkill[]> {
  const kind = await pathKind(path);
  if (!kind) return [];
  if (kind === "file") return [withSource(await loadSkillFile(path), source, dirname(path))];
  return (await loadLocalSkills(path)).map((skill) => withSource(skill, source, skill.root));
}

async function pathKind(path: string): Promise<"file" | "directory" | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function withSource(skill: LoadedSkill, source: Exclude<SkillSource, "mcp">, root: string): LoadedSkill {
  return { ...skill, source, root };
}

function resolveMode(skill: LoadedSkill, requested: SkillMode | undefined): "inline" | "fork" {
  const mode = requested ?? skill.mode ?? "inline";
  return mode === "auto" ? "inline" : mode;
}

function skillSystemMessage(skill: LoadedSkill): ModelMessage {
  return {
    role: "system",
    content: `SKILL ${skill.name}\n\n${skill.prompt.trim()}`
  };
}

function narrowedTools(registry: ToolRegistry | undefined, allowedTools: string[] | undefined): Tool[] {
  if (!registry) return [];
  const tools = registry.list();
  if (!allowedTools?.length) return tools;
  const allowed = new Set(allowedTools);
  return tools.filter((tool) => allowed.has(tool.name));
}

function registerSkillHooks(runtime: HookRuntime | undefined, skill: LoadedSkill): string[] {
  if (!runtime) return [];
  return registerSkillHooksFromRuntime(runtime, skill.hooks, skill.name, skill.root);
}

function registerSkillHooksFromRuntime(runtime: HookRuntime, hooks: LoadedSkill["hooks"], skillName: string, skillRoot: string): string[] {
  return registerHooksFromSkill(runtime, hooks, skillName, skillRoot);
}

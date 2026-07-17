import type { ModelMessage } from "../providers/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type { SkillRuntime } from "./runtime.js";

const skillActivationDataType = "skill_activation";

export type SkillActivationRecord = {
  name: string;
  mode: "inline" | "fork";
  source: string;
  version?: string;
  allowedTools: string[];
};

type SkillActivationData = SkillActivationRecord & {
  type: typeof skillActivationDataType;
  systemMessage?: ModelMessage;
  model?: string;
  effort?: string | number;
};

export function createListSkillsTool(runtime: SkillRuntime): Tool {
  return {
    name: "ListSkills",
    description: "List model-invocable skills and their routing guidance.",
    input_schema: {
      type: "object",
      properties: { filter: { type: "string" } },
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const filter = optionalString(input, "filter")?.toLowerCase();
      const skills = runtime.listModelInvocableSkills()
        .filter((skill) => !filter || [skill.name, skill.description, skill.whenToUse, skill.prompt].some((value) => value?.toLowerCase().includes(filter)))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          source: skill.source,
          mode: skill.mode ?? "inline",
          argumentHint: skill.argumentHint,
          version: skill.version,
          allowedTools: skill.allowedTools
        }));
      return {
        output: skills.map((skill) => [skill.name, skill.source, skill.mode, skill.description, skill.whenToUse].filter(Boolean).join(" ")).join("\n"),
        data: skills
      };
    }
  };
}

export function createUseSkillTool(runtime: SkillRuntime): Tool {
  return {
    name: "UseSkill",
    description: "Activate a model-invocable skill by name, with optional arguments.",
    prompt: () => skillRoutingPrompt(runtime),
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "string" },
        mode: { type: "string", enum: ["inline", "fork", "auto"] }
      },
      required: ["name"],
      additionalProperties: false
    },
    isReadOnly(input) {
      const name = optionalString(input, "name");
      return !name || !runtime.skillRequiresShell(name);
    },
    requiresPermissionPrompt(input) {
      const name = optionalString(input, "name");
      if (!name) return true;
      const skill = runtime.getSkill(name);
      return !skill || runtime.skillRequiresShell(name) || Boolean(skill.allowedTools?.length);
    },
    async validateInput(input) {
      const value = requiredObject(input);
      const name = requiredString(value, "name");
      const skill = runtime.getSkill(name);
      if (!skill) return { result: false, message: `Unknown or inactive skill ${name}` };
      if (skill.disableModelInvocation === true) return { result: false, message: `Skill ${name} disables model invocation` };
      return { result: true };
    },
    async execute(input, context) {
      const value = requiredObject(input);
      const name = requiredString(value, "name");
      const skill = runtime.getSkill(name);
      if (!skill) throw new Error(`Unknown or inactive skill ${name}`);
      if (skill.disableModelInvocation === true) throw new Error(`Skill ${name} disables model invocation`);
      const activation = await runtime.activateSkill(name, {
        mode: optionalSkillMode(value.mode),
        args: optionalValueString(value.args),
        prompt: optionalValueString(value.args),
        cwd: context.cwd,
        sessionId: context.sessionId ?? "global",
        provider: context.provider,
        model: context.model,
        tools: context.toolRegistry,
        parentPermissionMode: context.permissionMode,
        signal: context.abortSignal
      });
      const systemMessage = activation.mode === "inline"
        ? activation.messages.at(-1)
        : { role: "system" as const, content: `SKILL ${activation.skill.name}\n\n${activation.output}` };
      return skillActivationResult(activation.skill, activation.mode, systemMessage);
    },
    mapToolResultToModelResult(result) {
      return result.output ?? result;
    }
  };
}


export function skillActivationFromToolResult(result: ToolResult | undefined): SkillActivationRecord | undefined {
  const data = skillActivationData(result);
  if (!data) return undefined;
  return {
    name: data.name,
    mode: data.mode,
    source: data.source,
    ...(data.version ? { version: data.version } : {}),
    allowedTools: data.allowedTools.slice()
  };
}

export function skillPermissionRulesFromToolResult(result: ToolResult | undefined): string[] {
  const activation = skillActivationFromToolResult(result);
  return activation?.mode === "inline" ? activation.allowedTools : [];
}

export function skillRuntimeOverridesFromToolResult(result: ToolResult | undefined): { model?: string; effort?: string | number } | undefined {
  const data = skillActivationData(result);
  if (!data) return undefined;
  return {
    ...(data.model ? { model: data.model } : {}),
    ...(data.effort !== undefined ? { effort: data.effort } : {})
  };
}

export function skillSystemMessageFromToolResult(result: ToolResult | undefined): ModelMessage | undefined {
  const data = skillActivationData(result);
  if (!data) return undefined;
  const message = data.systemMessage;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const value = message as { role?: unknown; content?: unknown };
  return value.role === "system" && typeof value.content === "string" ? { role: "system", content: value.content } : undefined;
}

function skillActivationResult(
  skill: NonNullable<ReturnType<SkillRuntime["getSkill"]>>,
  mode: "inline" | "fork",
  systemMessage: ModelMessage | undefined
): ToolResult {
  const allowedTools = [...new Set((skill.allowedTools ?? []).filter((rule) => typeof rule === "string" && rule.trim()).map((rule) => rule.trim()))];
  const data: SkillActivationData = {
    type: skillActivationDataType,
    name: skill.name,
    mode,
    source: skill.source,
    ...(skill.version ? { version: skill.version } : {}),
    allowedTools,
    ...(systemMessage ? { systemMessage } : {}),
    ...(skill.model ? { model: skill.model } : {}),
    ...(skill.effort !== undefined ? { effort: skill.effort } : {})
  };
  return { output: `Activated skill ${skill.name} (${mode}).`, data };
}

function skillActivationData(result: ToolResult | undefined): SkillActivationData | undefined {
  const data = result?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.type !== skillActivationDataType || typeof record.name !== "string") return undefined;
  if (record.mode !== "inline" && record.mode !== "fork") return undefined;
  if (typeof record.source !== "string") return undefined;
  const allowedTools = Array.isArray(record.allowedTools)
    ? [...new Set(record.allowedTools.filter((rule): rule is string => typeof rule === "string" && Boolean(rule.trim())).map((rule) => rule.trim()))]
    : [];
  return {
    type: skillActivationDataType,
    name: record.name,
    mode: record.mode,
    source: record.source,
    ...(typeof record.version === "string" && record.version ? { version: record.version } : {}),
    allowedTools,
    ...(record.systemMessage && typeof record.systemMessage === "object" && !Array.isArray(record.systemMessage) ? { systemMessage: record.systemMessage as ModelMessage } : {}),
    ...(typeof record.model === "string" && record.model ? { model: record.model } : {}),
    ...((typeof record.effort === "string" || typeof record.effort === "number") ? { effort: record.effort } : {})
  };
}

function skillRoutingPrompt(runtime: SkillRuntime): string {
  const skills = runtime.listModelInvocableSkills();
  if (!skills.length) return "";
  return [
    "Available skills can be activated with UseSkill when their routing guidance matches the user's task.",
    "Use ListSkills to search the full model-invocable skill catalog.",
    "Call UseSkill before doing the work when a skill is relevant.",
    "",
    "## Available skills",
    ...skills.flatMap((skill) => [
      "",
      `### ${skill.name}`,
      [
        skill.description,
        skill.whenToUse ? `when_to_use: ${skill.whenToUse}` : undefined,
        `source: ${skill.source}`,
        `mode: ${skill.mode ?? "inline"}`,
        skill.argumentHint ? `argument-hint: ${skill.argumentHint}` : undefined,
        skill.allowedTools?.length ? `allowed-tools: ${skill.allowedTools.join(", ")}` : undefined
      ].filter(Boolean).join("\n")
    ])
  ].join("\n");
}

function optionalString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return optionalValueString((input as Record<string, unknown>)[key]);
}

function optionalValueString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalSkillMode(value: unknown): "inline" | "fork" | "auto" | undefined {
  return value === "inline" || value === "fork" || value === "auto" ? value : undefined;
}

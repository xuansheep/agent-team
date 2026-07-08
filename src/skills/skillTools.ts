import type { HookRuntime } from "../hooks/runtime.js";
import type { ModelMessage } from "../providers/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type { SkillRuntime } from "./runtime.js";

const skillActivationDataType = "skill_activation";

export function createListSkillsTool(runtime: SkillRuntime): Tool {
  return {
    name: "ListSkills",
    description: "List available skills and when to use them.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string" }
      },
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const filter = optionalString(input, "filter")?.toLowerCase();
      const skills = runtime.listSkills()
        .filter((skill) => {
          if (!filter) return true;
          return [skill.name, skill.description, skill.whenToUse, skill.prompt].some((value) => value?.toLowerCase().includes(filter));
        })
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          source: skill.source,
          mode: skill.mode ?? "inline",
          allowedTools: skill.allowedTools
        }));
      return {
        output: skills.map((skill) => [
          skill.name,
          skill.source,
          skill.mode,
          skill.description,
          skill.whenToUse
        ].filter(Boolean).join(" ")).join("\n"),
        data: skills
      };
    }
  };
}

export function createUseSkillTool(runtime: SkillRuntime, options: { hookRuntime?: HookRuntime } = {}): Tool {
  const activeHookIdsBySessionSkill = new Map<string, string[]>();
  return {
    name: "UseSkill",
    description: "Activate a skill by name and inject its instructions into the current session.",
    prompt: () => skillRoutingPrompt(runtime),
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        mode: { type: "string", enum: ["inline", "fork", "auto"] }
      },
      required: ["name"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input, context) {
      const value = requiredObject(input);
      const name = requiredString(value, "name");
      const mode = optionalSkillMode(value.mode);
      const sessionId = context.sessionId ?? "global";
      const activation = await runtime.activateSkill(name, { mode, hookRuntime: options.hookRuntime, sessionId });
      const activationKey = `${sessionId}:${activation.skill.name}`;
      for (const previousHookId of activeHookIdsBySessionSkill.get(activationKey) ?? []) {
        options.hookRuntime?.removeSessionHook(previousHookId);
      }
      activeHookIdsBySessionSkill.set(activationKey, activation.hookIds);
      const systemMessage = activation.mode === "inline"
        ? activation.messages.at(-1)
        : { role: "system" as const, content: `SKILL ${activation.skill.name}\n\n${activation.output}` };
      return {
        output: `Activated skill ${activation.skill.name} (${activation.mode}).`,
        data: {
          type: skillActivationDataType,
          name: activation.skill.name,
          mode: activation.mode,
          hookIds: activation.hookIds,
          systemMessage
        }
      };
    },
    mapToolResultToModelResult(result) {
      return result.output ?? result;
    }
  };
}

export function skillSystemMessageFromToolResult(result: ToolResult | undefined): ModelMessage | undefined {
  const data = result?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as { type?: unknown; systemMessage?: unknown };
  if (record.type !== skillActivationDataType) return undefined;
  const message = record.systemMessage;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const value = message as { role?: unknown; content?: unknown };
  return value.role === "system" && typeof value.content === "string"
    ? { role: "system", content: value.content }
    : undefined;
}

function skillRoutingPrompt(runtime: SkillRuntime): string {
  const skills = runtime.listSkills();
  if (!skills.length) return "";
  return [
    "Available skills can be activated with UseSkill when their routing guidance matches the user's task.",
    "Use ListSkills if you need to search or inspect the full skill catalog.",
    "Call UseSkill with the skill name before doing the work when a skill is relevant.",
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
        skill.allowedTools?.length ? `allowed-tools: ${skill.allowedTools.join(", ")}` : undefined
      ].filter(Boolean).join("\n")
    ])
  ].join("\n");
}

function optionalString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalSkillMode(value: unknown): "inline" | "fork" | "auto" | undefined {
  return value === "inline" || value === "fork" || value === "auto" ? value : undefined;
}

import { commandDefinitions } from "../commands/registry.js";

export type SlashCommandSuggestion = {
  value: string;
  label: string;
  description: string;
  type: "command" | "argument";
};

export type SlashCommandCompletionContext = {
  workflows: string[];
  runs?: string[];
  skills?: Array<{ name: string; description?: string; argumentHint?: string }>;
};

export const slashCommandDefinitions = commandDefinitions();

export function slashCommandSuggestions(input: string, context: SlashCommandCompletionContext): SlashCommandSuggestion[] {
  if (!input.startsWith("/")) return [];
  const body = input.slice(1);
  const spaceIndex = body.indexOf(" ");
  if (spaceIndex === -1) {
    const partial = body.toLowerCase();
    const commands = slashCommandDefinitions
      .filter((command) => command.name.startsWith(partial))
      .map((command) => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description, type: "command" as const }));
    const skills = (context.skills ?? [])
      .filter((skill) => skill.name.toLowerCase().startsWith(partial))
      .map((skill) => ({ value: `/${skill.name}`, label: `/${skill.name}`, description: skill.description ?? "Skill", type: "command" as const }));
    return [...commands, ...skills].sort((left, right) => left.value.localeCompare(right.value));
  }

  const commandName = body.slice(0, spaceIndex);
  const argument = body.slice(spaceIndex + 1).toLowerCase();
  if (commandName === "resume") return argumentSuggestions("/resume", context.runs ?? [], argument, "session");
  if (commandName === "statusline") return argumentSuggestions("/statusline", ["mode,workflow,run", "mode,permission,workflow,selection", "default"], argument, "statusline elements");
  if (commandName === "mcp") return argumentSuggestions("/mcp", ["enable", "disable", "reconnect"], argument, "mcp action");
  const skill = context.skills?.find((candidate) => candidate.name === commandName);
  if (skill?.argumentHint) return [{ value: input, label: skill.argumentHint, description: "skill arguments", type: "argument" }];
  return [];
}

export function applySlashCommandSuggestion(_input: string, suggestion: SlashCommandSuggestion): { text: string; cursor: number } {
  const text = `${suggestion.value} `;
  return { text, cursor: text.length };
}

export function commandArgumentHint(input: string): string | undefined {
  if (!input.startsWith("/")) return undefined;
  const body = input.slice(1);
  const [name] = body.split(/\s+/, 1);
  const definition = slashCommandDefinitions.find((command) => command.name === name);
  if (!definition?.argumentHint) return undefined;
  if (!input.endsWith(" ") && input.trim().split(/\s+/).length > 1) return undefined;
  return definition.argumentHint;
}

function argumentSuggestions(prefix: string, values: string[], partial: string, description: string): SlashCommandSuggestion[] {
  return values
    .filter((value) => value.toLowerCase().startsWith(partial))
    .map((value) => ({ value: `${prefix} ${value}`, label: value, description, type: "argument" as const }));
}

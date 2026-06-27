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
};

export const slashCommandDefinitions = commandDefinitions();

export function slashCommandSuggestions(input: string, context: SlashCommandCompletionContext): SlashCommandSuggestion[] {
  if (!input.startsWith("/")) return [];
  const body = input.slice(1);
  const spaceIndex = body.indexOf(" ");
  if (spaceIndex === -1) {
    const partial = body.toLowerCase();
    return slashCommandDefinitions
      .filter((command) => command.name.startsWith(partial))
      .map((command) => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description, type: "command" as const }));
  }

  const commandName = body.slice(0, spaceIndex);
  const argument = body.slice(spaceIndex + 1).toLowerCase();
  if (commandName === "resume") return argumentSuggestions("/resume", context.runs ?? [], argument, "session");
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

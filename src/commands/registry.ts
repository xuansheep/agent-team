export type CommandName = "clear" | "help" | "model" | "new" | "permissions" | "plan" | "resume";

export type CommandDefinition = {
  name: CommandName;
  description: string;
  argumentHint?: string;
  parse(args: string[]): CommandAction;
};

export type CommandAction =
  | { type: "clear"; args: string[] }
  | { type: "help"; args: string[] }
  | { type: "model"; args: string[]; model?: string }
  | { type: "new"; args: string[] }
  | { type: "permissions"; args: string[] }
  | { type: "plan"; args: string[]; behavior: "enter_or_request_approval" }
  | { type: "resume"; args: string[]; runId?: string };

const definitions: CommandDefinition[] = [
  { name: "clear", description: "Clear current context", parse: (args) => ({ type: "clear", args }) },
  { name: "help", description: "Show help", parse: (args) => ({ type: "help", args }) },
  { name: "model", description: "Switch model", argumentHint: "<model>", parse: (args) => ({ type: "model", args, model: args[0] }) },
  { name: "new", description: "Start a new session", parse: (args) => ({ type: "new", args }) },
  { name: "permissions", description: "Show or change permissions", parse: (args) => ({ type: "permissions", args }) },
  { name: "plan", description: "Enter or exit Plan Mode", parse: (args) => ({ type: "plan", args, behavior: "enter_or_request_approval" }) },
  { name: "resume", description: "Resume a session", argumentHint: "<session>", parse: (args) => ({ type: "resume", args, runId: args[0] }) }
];

const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));

export function commandDefinitions(): CommandDefinition[] {
  return definitions.slice();
}

export function commandNames(): CommandName[] {
  return definitions.map((definition) => definition.name).sort();
}

export function parseCommandAction(input: string): CommandAction | undefined {
  const parsed = parseCommandLine(input);
  if (!parsed) return undefined;
  return definitionByName.get(parsed.name)?.parse(parsed.args);
}

export function parseCommandLine(input: string): { name: CommandName; args: string[] } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!rawName || !definitionByName.has(rawName as CommandName)) return undefined;
  return { name: rawName as CommandName, args };
}

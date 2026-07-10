export type CommandName = "clear" | "diagnostics" | "help" | "mcp" | "model" | "new" | "permissions" | "plan" | "resume" | "skills" | "statusline";

export type CommandDefinition = {
  name: CommandName;
  description: string;
  argumentHint?: string;
  parse(args: string[]): CommandAction;
};

export type CommandAction =
  | { type: "clear"; args: string[] }
  | { type: "diagnostics"; args: string[] }
  | { type: "help"; args: string[] }
  | { type: "mcp"; args: string[]; subcommand?: "enable" | "disable" | "reconnect"; serverName?: string }
  | { type: "model"; args: string[]; model?: string }
  | { type: "new"; args: string[] }
  | { type: "permissions"; args: string[] }
  | { type: "plan"; args: string[]; behavior: "enter_or_show_plan" }
  | { type: "resume"; args: string[]; runId?: string }
  | { type: "skills"; args: string[] }
  | { type: "statusline"; args: string[] };

const definitions: CommandDefinition[] = [
  { name: "clear", description: "Clear current context", parse: (args) => ({ type: "clear", args }) },
  { name: "diagnostics", description: "Show runtime diagnostics", parse: (args) => ({ type: "diagnostics", args }) },
  { name: "help", description: "Show help", parse: (args) => ({ type: "help", args }) },
  { name: "mcp", description: "Manage MCP servers", argumentHint: "[enable|disable|reconnect [server-name]]", parse: parseMcpCommand },
  { name: "model", description: "Switch model", argumentHint: "<model>", parse: (args) => ({ type: "model", args, model: args[0] }) },
  { name: "new", description: "Start a new session", parse: (args) => ({ type: "new", args }) },
  { name: "permissions", description: "Show or change permissions", parse: (args) => ({ type: "permissions", args }) },
  { name: "plan", description: "Enter Plan Mode or show the current plan", argumentHint: "[open|<description>]", parse: (args) => ({ type: "plan", args, behavior: "enter_or_show_plan" }) },
  { name: "resume", description: "Resume a session", argumentHint: "<session>", parse: (args) => ({ type: "resume", args, runId: args[0] }) },
  { name: "skills", description: "List available skills", argumentHint: "[refresh]", parse: (args) => ({ type: "skills", args }) },
  { name: "statusline", description: "Customize bottom statusline elements", argumentHint: "[mode,permission,workflow,run,selection,loading|default]", parse: (args) => ({ type: "statusline", args }) }
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

function parseMcpCommand(args: string[]): CommandAction {
  const [candidate, serverName] = args;
  const subcommand = candidate === "enable" || candidate === "disable" || candidate === "reconnect" ? candidate : undefined;
  if (!subcommand) return { type: "mcp", args };
  return { type: "mcp", args, subcommand, serverName };
}

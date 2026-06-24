export type SlashCommand = {
  name: "resume" | "help" | "new";
  args: string[];
};

const commandNames = new Set(["resume", "help", "new"]);

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const [rawName, ...args] = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!rawName || !commandNames.has(rawName)) return undefined;

  return { name: rawName as SlashCommand["name"], args };
}

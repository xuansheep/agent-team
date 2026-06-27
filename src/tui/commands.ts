import { CommandName, parseCommandLine } from "../commands/registry.js";

export type SlashCommand = {
  name: CommandName;
  args: string[];
};

export function parseSlashCommand(input: string): SlashCommand | undefined {
  return parseCommandLine(input);
}

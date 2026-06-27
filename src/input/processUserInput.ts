import { CommandAction, parseCommandAction } from "../commands/registry.js";

export type ProcessedUserInput =
  | { type: "empty" }
  | { type: "query"; text: string }
  | { type: "command"; command: CommandAction };

export function processUserInput(input: string): ProcessedUserInput {
  const text = input.trim();
  if (!text) return { type: "empty" };
  const command = parseCommandAction(text);
  if (command) return { type: "command", command };
  return { type: "query", text };
}

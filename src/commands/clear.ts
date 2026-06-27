import { CommandAction } from "./registry.js";

export function clearCommand(args: string[] = []): CommandAction {
  return { type: "clear", args };
}

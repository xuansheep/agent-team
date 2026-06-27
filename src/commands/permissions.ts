import { CommandAction } from "./registry.js";

export function permissionsCommand(args: string[] = []): CommandAction {
  return { type: "permissions", args };
}

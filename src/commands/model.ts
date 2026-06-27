import { CommandAction } from "./registry.js";

export function modelCommand(args: string[] = []): CommandAction {
  return { type: "model", args, model: args[0] };
}

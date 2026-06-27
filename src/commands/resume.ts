import { CommandAction } from "./registry.js";

export function resumeCommand(args: string[] = []): CommandAction {
  return { type: "resume", args, runId: args[0] };
}

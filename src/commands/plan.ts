import { CommandAction } from "./registry.js";

export function planCommand(args: string[] = []): CommandAction {
  return { type: "plan", args, behavior: "enter_or_show_plan" };
}

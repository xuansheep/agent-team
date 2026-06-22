import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerRunCommand } from "./commands/run.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerInspectCommand } from "./commands/inspect.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("agent-team")
    .description("Run a local configurable agent team workflow")
    .version("0.1.0");

  registerInitCommand(program);
  registerRunCommand(program);
  registerResumeCommand(program);
  registerStatusCommand(program);
  registerInspectCommand(program);

  return program;
}

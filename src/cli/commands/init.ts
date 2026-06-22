import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";

export function registerInitCommand(program: Command): void {
  program.command("init").description("Create an example agent-team.yaml").action(async () => {
    await copyFile(join(process.cwd(), "agent-team.example.yaml"), join(process.cwd(), "agent-team.yaml"));
    console.log("Created agent-team.yaml");
  });
}

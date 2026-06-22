import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";

export function registerStatusCommand(program: Command): void {
  program.command("status").argument("<run_id>").description("Show run state").action(async (runId) => {
    const state = await readFile(join(".runs", runId, "state.json"), "utf8");
    console.log(state);
  });
}

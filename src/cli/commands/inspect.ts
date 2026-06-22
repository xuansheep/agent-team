import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";

export function registerInspectCommand(program: Command): void {
  program.command("inspect").argument("<run_id>").description("Show run event log").action(async (runId) => {
    const events = await readFile(join(".runs", runId, "events.ndjson"), "utf8");
    console.log(events);
  });
}

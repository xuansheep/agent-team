import { Command } from "commander";
import { loadConfig } from "../../config/loadConfig.js";
import { createProvider } from "../../providers/registry.js";
import { WorkflowEngine } from "../../workflow/engine.js";

export function registerResumeCommand(program: Command): void {
  program.command("resume")
    .argument("<run_id>")
    .requiredOption("-f, --file <path>", "config file")
    .option("-w, --workflow <id>", "workflow id", "delivery")
    .requiredOption("--answer <text>", "user answer for waiting_user state")
    .description("Resume a waiting or interrupted run")
    .action(async (runId, options) => {
      const config = await loadConfig(options.file);
      const engine = new WorkflowEngine({ providerFactory: (providerId) => createProvider(config, providerId), cwd: process.cwd() });
      const result = await engine.resume(config, options.workflow, runId, { answer: options.answer });
      console.log(JSON.stringify(result, null, 2));
    });
}

import { Command } from "commander";
import { loadConfig } from "../../config/loadConfig.js";
import { createProvider } from "../../providers/registry.js";
import { WorkflowEngine } from "../../workflow/engine.js";

export function registerRunCommand(program: Command): void {
  program.command("run")
    .requiredOption("-f, --file <path>", "config file")
    .option("-w, --workflow <id>", "workflow id", "delivery")
    .requiredOption("--input <text>", "user request")
    .option("--image <path...>", "input image paths")
    .action(async (options) => {
      const config = await loadConfig(options.file);
      const engine = new WorkflowEngine({ providerFactory: (providerId) => createProvider(config, providerId), cwd: process.cwd() });
      const result = await engine.run(config, options.workflow, { request: options.input, images: options.image ?? [] });
      console.log(JSON.stringify(result, null, 2));
    });
}

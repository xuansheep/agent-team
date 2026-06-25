import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import { AgentTeamConfig, configSchema } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";

export async function loadConfig(path: string): Promise<AgentTeamConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw);
  const config = configSchema.parse(parsed);
  if (config.global_prompt_file) {
    config.global_prompt = await readFile(resolve(dirname(path), config.global_prompt_file), "utf8");
  }
  return resolveConfig(config);
}

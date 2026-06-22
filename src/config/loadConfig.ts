import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { AgentTeamConfig, configSchema } from "./schema.js";
import { resolveConfig } from "./resolveConfig.js";

export async function loadConfig(path: string): Promise<AgentTeamConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw);
  const config = configSchema.parse(parsed);
  return resolveConfig(config);
}

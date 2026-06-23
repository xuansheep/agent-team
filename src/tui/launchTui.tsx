import React from "react";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { render } from "./ink.js";
import { AgentTeamConfig } from "../config/schema.js";
import { loadConfig } from "../config/loadConfig.js";
import { createProvider } from "../providers/registry.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { TuiApp } from "./TuiApp.js";

export function selectDefaultWorkflow(workflows: string[]): string | undefined {
  if (workflows.includes("delivery")) return "delivery";
  if (workflows.length === 1) return workflows[0];
  return undefined;
}

export async function launchTui(options: { cwd: string }): Promise<void> {
  const configPath = join(options.cwd, "agent-team.yaml");
  let initialError: string | undefined;
  let config: AgentTeamConfig | undefined;
  let workflows: string[] = [];
  let workflowId: string | undefined;
  let engine: WorkflowEngine | undefined;

  try {
    await access(configPath);
    const loadedConfig = await loadConfig(configPath);
    config = loadedConfig;
    workflows = Object.keys(config.workflows);
    workflowId = selectDefaultWorkflow(workflows);
    engine = new WorkflowEngine({ providerFactory: (providerId) => createProvider(loadedConfig, providerId), cwd: options.cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    initialError = message.includes("ENOENT") ? "Missing agent-team.yaml" : message;
  }

  const instance = await render(<TuiApp cwd={options.cwd} initialError={initialError} config={config} workflows={workflows} workflowId={workflowId} engine={engine} />, {
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
}

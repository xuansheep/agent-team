import { access } from "node:fs/promises";
import { join } from "node:path";
import { AlternateScreen, render } from "./ink.js";
import { AgentTeamConfig } from "../config/schema.js";
import { loadConfig } from "../config/loadConfig.js";
import { loadMergedMcpServers } from "../mcp/config.js";
import { McpRuntime } from "../mcp/runtime.js";
import { createMcpClientFactory } from "../mcp/transports.js";
import { createProvider } from "../providers/registry.js";
import { loadSettings } from "../settings/loadSettings.js";
import type { ResolvedAgentTeamSettings } from "../settings/types.js";
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
  let settings: ResolvedAgentTeamSettings | undefined;
  let mcpRuntime: McpRuntime | undefined;

  try {
    await access(configPath);
    settings = await loadSettings({ cwd: options.cwd });
    const loadedConfig = await loadConfig(configPath, { cwd: options.cwd, settings });
    config = loadedConfig;
    workflows = Object.keys(config.workflows);
    workflowId = selectDefaultWorkflow(workflows);
    const mcpServers = await loadMergedMcpServers({ cwd: options.cwd, agentTeamServers: loadedConfig.mcpServers });
    mcpRuntime = new McpRuntime({ clientFactory: createMcpClientFactory() });
    await mcpRuntime.connectAll(mcpServers);
    engine = new WorkflowEngine({ providerFactory: (providerId) => createProvider(loadedConfig, providerId), cwd: options.cwd, runRoot: join(options.cwd, ".session"), mcpRuntime });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    initialError = message.includes("ENOENT") ? "Missing agent-team.yaml" : message;
  }

  const instance = await render(
    <AlternateScreen mouseTracking>
      <TuiApp
        cwd={options.cwd}
        initialError={initialError}
        config={config}
        workflows={workflows}
        workflowId={workflowId}
        engine={engine}
        providerFactory={config ? (providerId) => createProvider(config!, providerId) : undefined}
        settings={settings}
        mcpRuntime={mcpRuntime}
      />
    </AlternateScreen>,
    {
    exitOnCtrlC: false
    }
  );
  await instance.waitUntilExit();
}

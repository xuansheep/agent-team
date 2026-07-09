import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AlternateScreen, render } from "./ink.js";
import { AgentTeamConfig } from "../config/schema.js";
import { loadConfig } from "../config/loadConfig.js";
import { collectRuntimeDiagnostics, type RuntimeDiagnostics } from "../diagnostics/runtimeDiagnostics.js";
import { HookRuntime } from "../hooks/runtime.js";
import { loadMergedMcpServersWithSourceDetails, type McpConfigSourceOptions } from "../mcp/config.js";
import { McpRuntime } from "../mcp/runtime.js";
import { createMcpClientFactory } from "../mcp/transports.js";
import { createProvider } from "../providers/registry.js";
import { loadSettings } from "../settings/loadSettings.js";
import type { ResolvedAgentTeamSettings } from "../settings/types.js";
import { loadMcpPromptSkills } from "../skills/mcpSkills.js";
import { SkillRuntime } from "../skills/runtime.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { TuiApp } from "./TuiApp.js";

export function selectDefaultWorkflow(workflows: string[]): string | undefined {
  if (workflows.includes("delivery")) return "delivery";
  if (workflows.length === 1) return workflows[0];
  return undefined;
}

export type PreparedTuiRuntime = {
  config: AgentTeamConfig;
  workflows: string[];
  workflowId: string | undefined;
  engine: WorkflowEngine;
  settings: ResolvedAgentTeamSettings;
  mcpRuntime: McpRuntime;
  skillRuntime: SkillRuntime;
  hookRuntime: HookRuntime;
  diagnostics: RuntimeDiagnostics;
  mcpConfigOptions: McpConfigSourceOptions;
};

export async function prepareTuiRuntime(options: { cwd: string }): Promise<PreparedTuiRuntime> {
  const configPath = join(options.cwd, "agent-team.yaml");
  await access(configPath);
  const settings = await loadSettings({ cwd: options.cwd });
  const config = await loadConfig(configPath, { cwd: options.cwd, settings });
  const workflows = Object.keys(config.workflows);
  const workflowId = selectDefaultWorkflow(workflows);
  const mcpConfigOptions = { cwd: options.cwd, agentTeamPath: configPath, agentTeamServers: config.mcpServers };
  const mcpServers = await loadMergedMcpServersWithSourceDetails(mcpConfigOptions);
  const mcpRuntime = new McpRuntime({ clientFactory: createMcpClientFactory() });
  await mcpRuntime.connectAll(mcpServers);
  const skillRuntime = await SkillRuntime.discover({
    cwd: options.cwd,
    explicitProjectSkillPaths: (config.skills?.paths ?? []).map((path) => isAbsolute(path) ? path : join(options.cwd, path)),
    mcpSkills: () => loadMcpPromptSkills(mcpRuntime)
  });
  const hookRuntime = new HookRuntime(settings.hooks);
  const engine = new WorkflowEngine({ providerFactory: (providerId) => createProvider(config, providerId), cwd: options.cwd, runRoot: join(options.cwd, ".session"), mcpRuntime, hookRuntime });
  const diagnostics = collectRuntimeDiagnostics({ mcpRuntime, skillRuntime, hookRuntime });
  return { config, workflows, workflowId, engine, settings, mcpRuntime, skillRuntime, hookRuntime, diagnostics, mcpConfigOptions };
}

export async function launchTui(options: { cwd: string }): Promise<void> {
  let initialError: string | undefined;
  let config: AgentTeamConfig | undefined;
  let workflows: string[] = [];
  let workflowId: string | undefined;
  let engine: WorkflowEngine | undefined;
  let settings: ResolvedAgentTeamSettings | undefined;
  let mcpRuntime: McpRuntime | undefined;
  let skillRuntime: SkillRuntime | undefined;
  let hookRuntime: HookRuntime | undefined;
  let diagnostics: RuntimeDiagnostics | undefined;
  let mcpConfigOptions: McpConfigSourceOptions | undefined;

  try {
    const prepared = await prepareTuiRuntime(options);
    config = prepared.config;
    workflows = prepared.workflows;
    workflowId = prepared.workflowId;
    engine = prepared.engine;
    settings = prepared.settings;
    mcpRuntime = prepared.mcpRuntime;
    skillRuntime = prepared.skillRuntime;
    hookRuntime = prepared.hookRuntime;
    diagnostics = prepared.diagnostics;
    mcpConfigOptions = prepared.mcpConfigOptions;
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
        skillRuntime={skillRuntime}
        hookRuntime={hookRuntime}
        diagnostics={diagnostics}
        collectDiagnostics={() => collectRuntimeDiagnostics({ mcpRuntime, skillRuntime, hookRuntime })}
        mcpConfigOptions={mcpConfigOptions}
      />
    </AlternateScreen>,
    {
      exitOnCtrlC: false
    }
  );
  await instance.waitUntilExit();
}

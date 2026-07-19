import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { loadConfig } from "../../src/config/loadConfig.js";
import type { LoadConfigOptions } from "../../src/config/loadConfig.js";
import { settingsSchema } from "../../src/settings/types.js";
import { writeProjectConfig, type TestRole, type TestWorkflow } from "../helpers/projectConfig.js";

const defaultProvider = {
  type: "openai-compatible" as const,
  base_url: "https://api.example.test/v1",
  api_key: "test-key",
  default_model: "gpt-test",
  capabilities: { tool_calling: true, vision: true }
};

function providerSettings(provider: unknown = defaultProvider) {
  return settingsSchema.parse({ providers: { default: provider, deepseek: provider } });
}

async function loadTestConfig(path: string, options: LoadConfigOptions = {}) {
  const configDir = await fixtureConfigDir(path);
  return loadConfig(configDir, { ...options, settings: options.settings ?? providerSettings() });
}

async function tempFile(name: string, text: string) {
  const dir = await mkdtemp(join(tmpdir(), "agent-team-config-"));
  const file = join(dir, name);
  await writeFile(file, text, "utf8");
  return file;
}

async function fixtureConfigDir(path: string): Promise<string> {
  if ((await stat(path)).isDirectory()) return path;
  const parsed = yaml.load(await readFile(path, "utf8")) as {
    global_prompt_file?: string;
    roles?: Record<string, TestRole>;
    workflows?: Record<string, TestWorkflow & { edges?: unknown }>;
  };
  const prompt = parsed.global_prompt_file
    ? await readFile(join(dirname(path), parsed.global_prompt_file), "utf8")
    : "";
  const workflows = Object.fromEntries(Object.entries(parsed.workflows ?? {}).map(([name, workflow]) => [name, {
    nodes: workflow.nodes,
    ...(workflow.workflow_permissions ? { workflow_permissions: workflow.workflow_permissions } : {})
  }]));
  return writeProjectConfig(dirname(path), { prompt, roles: parsed.roles, workflows });
}

describe("loadConfig", () => {
  it("loads a valid directory config", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    description: Product role
    system_prompt: Clarify requirements.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file);

    assert.equal(config.providers.default.type, "openai-compatible");
    assert.equal(config.providers.default.api_key_mode, "bearer");
    assert.equal(config.workflows.delivery.nodes[0].id, "product");
    assert.equal(config.workflows.delivery.nodes[0].mode, "task");
    assert.deepEqual(config.roles.product.requires, { tool_calling: true, vision: true });
  });

  it("defaults omitted workflow edges to an empty array", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
  final_delivery:
    system_prompt: Complete summary.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
      - id: final_delivery
        role: final_delivery
        provider: default
        mode: complete
`);

    const config = await loadTestConfig(file);

    assert.deepEqual(config.workflows.delivery.edges, []);
    assert.equal(config.workflows.delivery.nodes[1]?.id, "final_delivery");
  });

  it("loads Responses API provider defaults", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file, { settings: providerSettings({
      type: "responses-api",
      base_url: "https://api.openai.test/v1",
      api_key: "test-key",
      default_model: "gpt-test"
    }) });
    const provider = config.providers.default;

    assert.equal(provider.type, "responses-api");
    assert.equal(provider.api_key_mode, "bearer");
    assert.equal(provider.responses.prompt_cache, true);
    assert.equal(provider.responses.parallel_tool_calls, true);
  });

  it("loads Anthropic provider defaults", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file, { settings: providerSettings({
      type: "anthropic",
      base_url: "https://api.anthropic.test",
      api_key: "test-key",
      default_model: "claude-test"
    }) });
    const provider = config.providers.default;

    assert.equal(provider.type, "anthropic");
    assert.equal(provider.api_key_mode, "x-api-key");
    assert.equal(provider.anthropic.version, "2023-06-01");
    assert.equal(provider.anthropic.max_tokens, 8192);
    assert.equal(provider.anthropic.prompt_cache, true);
  });

  it("allows disabling Anthropic prompt cache", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file, { settings: providerSettings({
      type: "anthropic",
      base_url: "https://api.anthropic.test",
      api_key: "test-key",
      default_model: "claude-test",
      anthropic: { prompt_cache: false }
    }) });
    const provider = config.providers.default;

    assert.equal(provider.type, "anthropic");
    assert.equal(provider.anthropic.prompt_cache, false);
  });

  it("allows API key mode overrides", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file, { settings: providerSettings({
      type: "anthropic",
      base_url: "https://api.anthropic.test",
      api_key: "test-key",
      api_key_mode: "bearer",
      default_model: "claude-test"
    }) });

    assert.equal(config.providers.default.api_key_mode, "bearer");
  });

  it("loads complete node mode and rejects plan node mode", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
  final_delivery:
    system_prompt: Complete summary.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
      - id: final_delivery
        role: final_delivery
        provider: default
        mode: complete
    edges:
      - from: product
        to: final_delivery
        condition: success
`);

    const config = await loadTestConfig(file);

    assert.equal(config.workflows.delivery.nodes[1]?.mode, "complete");

    const planFile = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
        mode: plan
    edges: []
`);

    await assert.rejects(() => loadTestConfig(planFile), /Invalid enum value/);
  });

  it("loads the bundled four-node resumable delivery workflow", async () => {
    const config = await loadTestConfig(resolve("config"));
    const workflow = config.workflows.delivery;

    assert.equal(config.roles.user_acceptance, undefined);
    assert.equal(workflow.nodes.some((node) => node.id === "user_acceptance" || node.role === "user_acceptance"), false);
    assert.deepEqual(workflow.nodes.map((node) => node.id), ["product", "ui", "developer", "tester"]);
    assert.equal(workflow.nodes.every((node) => node.provider === "default"), true);
    assert.equal(workflow.nodes.find((node) => node.id === "tester")?.mode, "complete");
    assert.equal(workflow.max_rework_cycles, 99);
    assert.equal(workflow.edges.length, 0);
    assert.equal(workflow.edges.some((edge) => edge.from === "user_acceptance" || edge.to === "user_acceptance"), false);
  });

  it("defaults workflow rework cycles to 99", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-default-rework-"));
    const config = await loadTestConfig(await writeProjectConfig(dir));

    assert.equal(config.workflows.delivery.max_rework_cycles, 99);
  });

  it("loads provider user_agent override", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file, { settings: providerSettings({
      ...defaultProvider,
      user_agent: "custom-agent/1.0"
    }) });

    assert.equal(config.providers.default.user_agent, "custom-agent/1.0");
  });

  it("loads the fixed config prompt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-global-prompt-"));
    const promptFile = join(dir, "GLOBAL.md");
    const configFile = join(dir, "agent-team.yaml");
    await writeFile(promptFile, "Global safety rules.\nApply to every node.", "utf8");
    await writeFile(configFile, `
global_prompt_file: GLOBAL.md
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`, "utf8");

    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-empty-home-"));
    const config = await loadTestConfig(configFile, { cwd: dir, homeDir });

    assert.match(config.global_prompt ?? "", /Mandatory system instructions from .*config[\\/]prompt[.]md/);
    assert.match(config.global_prompt ?? "", /Global safety rules[.]\nApply to every node/);
  });

  it("loads the system prompt before user and project AGENTS prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-agents-prompt-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-agents-home-"));
    await mkdir(join(homeDir, ".einsteins"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, ".einsteins"), { recursive: true });
    await writeFile(join(homeDir, ".einsteins", "AGENTS.md"), "User instructions.\n", "utf8");
    await writeFile(join(dir, ".einsteins", "AGENTS.md"), "Project instructions.\n", "utf8");
    await writeFile(join(dir, "GLOBAL.md"), "Configured instructions.\n", "utf8");
    const configFile = join(dir, "agent-team.yaml");
    await writeFile(configFile, `
global_prompt_file: GLOBAL.md
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`, "utf8");

    const config = await loadTestConfig(configFile, { cwd: dir, homeDir });

    assert.match(config.global_prompt ?? "", /Configured instructions[\s\S]*User instructions[\s\S]*Project instructions/);
    assert.match(config.global_prompt ?? "", /never override or weaken/);
    assert.deepEqual(config.global_prompt_metadata?.sources.map((source) => source.kind), ["configured_file", "user_agents", "project_agents"]);
    assert.equal(config.global_prompt_metadata?.sources[2]?.path, join(dir, ".einsteins", "AGENTS.md"));
    assert.match(config.global_prompt_metadata?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(config.global_prompt_metadata).includes("Project instructions"), false);
  });

  it("ignores missing AGENTS prompt files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-missing-agents-prompt-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-missing-agents-home-"));
    const configFile = join(dir, "agent-team.yaml");
    await writeFile(configFile, `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: product
        role: product
        provider: default
    edges: []
`, "utf8");

    const config = await loadTestConfig(configFile, { cwd: dir, homeDir });

    assert.equal(config.global_prompt, undefined);
  });

  it("rejects nodes that reference missing roles", async () => {
    const file = await tempFile("agent-team.yaml", `
roles:
  product:
    system_prompt: Product plan.
workflows:
  delivery:
    nodes:
      - id: dev
        role: developer
        provider: default
    edges: []
`);

    await assert.rejects(() => loadTestConfig(file), /Unknown role developer/);
  });

  it("loads provider model routing metadata", async () => {
    const configPath = await tempFile("agent-team.yaml", `roles:
  dev:
    system_prompt: Build safely.
workflows:
  delivery:
    nodes:
      - id: dev
        role: dev
        provider: default
    edges: []
`);

    const config = await loadTestConfig(configPath, { settings: providerSettings({
      ...defaultProvider,
      default_model: "default-alias",
      plan_model: "plan-alias",
      model_aliases: { "default-alias": "gpt-default", "plan-alias": "gpt-plan" },
      context_windows: { "gpt-default": 128000 }
    }) });

    assert.equal(config.providers.default.plan_model, "plan-alias");
    assert.deepEqual(config.providers.default.model_aliases, { "default-alias": "gpt-default", "plan-alias": "gpt-plan" });
    assert.deepEqual(config.providers.default.context_windows, { "gpt-default": 128000 });
  });

  it("does not expose project MCP server configuration", async () => {
    const file = await tempFile("agent-team.yaml", `
mcpServers:
  local:
    type: stdio
    command: node
    args:
      - server.mjs
roles:
  dev:
    system_prompt: Build safely.
workflows:
  delivery:
    nodes:
      - id: dev
        role: dev
        provider: default
    edges: []
`);

    const config = await loadTestConfig(file);

    assert.equal(Object.hasOwn(config, "mcpServers"), false);
  });

  it("does not parse legacy agent-team.yaml files", async () => {
    const file = await tempFile("agent-team.yaml", `
providers: {}
roles:
  dev:
    system_prompt: Build safely.
workflows:
  delivery:
    nodes:
      - id: dev
        role: dev
`);

    await assert.rejects(() => loadConfig(file), /ENOENT|ENOTDIR/);
  });

  it("rejects edges in workflow JSON files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-workflow-edges-"));
    const configDir = await writeProjectConfig(dir);
    await writeFile(join(configDir, "workflows", "delivery.json"), JSON.stringify({
      name: "delivery",
      nodes: [{ id: "dev", role: "dev", provider: "default" }],
      edges: [{ from: "dev", to: "dev" }]
    }), "utf8");

    await assert.rejects(() => loadTestConfig(configDir), /Unrecognized key.*edges/s);
  });

  it("loads non-negotiable FullAccess boundaries for product and UI roles", async () => {
    const config = await loadConfig(resolve("config"), { settings: providerSettings() });

    assert.match(config.roles.product.system_prompt, /FullAccess mode.*do not override this role boundary/);
    assert.match(config.roles.product.system_prompt, /only permitted mutation.*ArtifactWrite/);
    assert.match(config.roles.product.system_prompt, /Never use Write, Edit, MultiEdit/);
    assert.match(config.roles.ui.system_prompt, /FullAccess mode.*do not override this role boundary/);
    assert.match(config.roles.ui.system_prompt, /only permitted mutations.*ArtifactWrite.*AttachImage/);
    assert.match(config.roles.ui.system_prompt, /Never use Write, Edit, MultiEdit/);
  });
});

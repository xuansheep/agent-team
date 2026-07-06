import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/loadConfig.js";

async function tempFile(name: string, text: string) {
  const dir = await mkdtemp(join(tmpdir(), "agent-team-config-"));
  const file = join(dir, name);
  await writeFile(file, text, "utf8");
  return file;
}

describe("loadConfig", () => {
  it("loads a valid single-file config", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
    capabilities:
      tool_calling: true
      vision: true
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

    const config = await loadConfig(file);

    assert.equal(config.providers.default.type, "openai-compatible");
    assert.equal(config.providers.default.api_key_mode, "bearer");
    assert.equal(config.workflows.delivery.nodes[0].id, "product");
    assert.equal(config.workflows.delivery.nodes[0].mode, "task");
  });

  it("defaults omitted workflow edges to an empty array", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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

    const config = await loadConfig(file);

    assert.deepEqual(config.workflows.delivery.edges, []);
    assert.equal(config.workflows.delivery.nodes[1]?.id, "final_delivery");
  });

  it("loads Responses API provider defaults", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: responses-api
    base_url: https://api.openai.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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

    const config = await loadConfig(file);
    const provider = config.providers.default;

    assert.equal(provider.type, "responses-api");
    assert.equal(provider.api_key_mode, "bearer");
    assert.equal(provider.responses.prompt_cache, true);
    assert.equal(provider.responses.parallel_tool_calls, true);
  });

  it("loads Anthropic provider defaults", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: anthropic
    base_url: https://api.anthropic.test
    api_key_env: TEST_API_KEY
    default_model: claude-test
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

    const config = await loadConfig(file);
    const provider = config.providers.default;

    assert.equal(provider.type, "anthropic");
    assert.equal(provider.api_key_mode, "x-api-key");
    assert.equal(provider.anthropic.version, "2023-06-01");
    assert.equal(provider.anthropic.max_tokens, 8192);
    assert.equal(provider.anthropic.prompt_cache, true);
  });

  it("allows disabling Anthropic prompt cache", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: anthropic
    base_url: https://api.anthropic.test
    api_key_env: TEST_API_KEY
    default_model: claude-test
    anthropic:
      prompt_cache: false
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

    const config = await loadConfig(file);
    const provider = config.providers.default;

    assert.equal(provider.type, "anthropic");
    assert.equal(provider.anthropic.prompt_cache, false);
  });

  it("allows API key mode overrides", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: anthropic
    base_url: https://api.anthropic.test
    api_key_env: TEST_API_KEY
    api_key_mode: bearer
    default_model: claude-test
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

    const config = await loadConfig(file);

    assert.equal(config.providers.default.api_key_mode, "bearer");
  });

  it("loads complete node mode and rejects plan node mode", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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

    const config = await loadConfig(file);

    assert.equal(config.workflows.delivery.nodes[1]?.mode, "complete");

    const planFile = await tempFile("agent-team.yaml", `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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

    await assert.rejects(() => loadConfig(planFile), /Invalid enum value/);
  });

  it("keeps the bundled example workflow free of user_acceptance nodes", async () => {
    const config = await loadConfig("agent-team.example.yaml");
    const workflow = config.workflows.delivery;

    assert.equal(config.roles.user_acceptance, undefined);
    assert.equal(workflow.nodes.some((node) => node.id === "user_acceptance" || node.role === "user_acceptance"), false);
    assert.equal(workflow.nodes.some((node) => node.id === "product"), false);
    assert.equal(workflow.nodes.find((node) => node.id === "final_delivery")?.mode, "complete");
    assert.equal(workflow.edges.length, 0);
    assert.equal(workflow.edges.some((edge) => edge.from === "user_acceptance" || edge.to === "user_acceptance"), false);
  });

  it("loads provider user_agent override", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
    user_agent: custom-agent/1.0
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

    const config = await loadConfig(file);

    assert.equal(config.providers.default.user_agent, "custom-agent/1.0");
  });

  it("loads a global prompt file relative to the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-global-prompt-"));
    const promptFile = join(dir, "GLOBAL.md");
    const configFile = join(dir, "agent-team.yaml");
    await writeFile(promptFile, "Global safety rules.\nApply to every node.", "utf8");
    await writeFile(configFile, `
global_prompt_file: GLOBAL.md
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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
    const config = await loadConfig(configFile, { cwd: dir, homeDir });

    assert.equal(config.global_prompt_file, "GLOBAL.md");
    assert.match(config.global_prompt ?? "", /Codebase and user instructions are shown below/);
    assert.match(config.global_prompt ?? "", /Contents of .*GLOBAL[.]md .*configured instructions/);
    assert.match(config.global_prompt ?? "", /Global safety rules[.]\nApply to every node/);
  });

  it("loads user and project AGENTS prompts before configured global prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-agents-prompt-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-agents-home-"));
    await mkdir(join(homeDir, ".einsteins"), { recursive: true });
    await mkdir(join(dir, ".agents"), { recursive: true });
    await writeFile(join(homeDir, ".einsteins", "AGENTS.md"), "User instructions.\n", "utf8");
    await writeFile(join(dir, ".agents", "AGENTS.md"), "Project instructions.\n", "utf8");
    await writeFile(join(dir, "GLOBAL.md"), "Configured instructions.\n", "utf8");
    const configFile = join(dir, "agent-team.yaml");
    await writeFile(configFile, `
global_prompt_file: GLOBAL.md
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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

    const config = await loadConfig(configFile, { cwd: dir, homeDir });

    assert.match(config.global_prompt ?? "", /User instructions[\s\S]*Project instructions[\s\S]*Configured instructions/);
    assert.deepEqual(config.global_prompt_metadata?.sources.map((source) => source.kind), ["user_agents", "project_agents", "configured_file"]);
    assert.equal(config.global_prompt_metadata?.sources[1]?.path, join(dir, ".agents", "AGENTS.md"));
    assert.match(config.global_prompt_metadata?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(config.global_prompt_metadata).includes("Project instructions"), false);
  });

  it("ignores missing AGENTS prompt files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-missing-agents-prompt-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-missing-agents-home-"));
    const configFile = join(dir, "agent-team.yaml");
    await writeFile(configFile, `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
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

    const config = await loadConfig(configFile, { cwd: dir, homeDir });

    assert.equal(config.global_prompt, undefined);
  });

  it("rejects nodes that reference missing roles", async () => {
    const file = await tempFile("agent-team.yaml", `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: gpt-test
roles: {}
workflows:
  delivery:
    nodes:
      - id: dev
        role: developer
        provider: default
    edges: []
`);

    await assert.rejects(() => loadConfig(file), /Unknown role developer/);
  });

  it("loads provider model routing metadata", async () => {
    const configPath = await tempFile("agent-team.yaml", `providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: default-alias
    plan_model: plan-alias
    model_aliases:
      default-alias: gpt-default
      plan-alias: gpt-plan
    context_windows:
      gpt-default: 128000
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

    const config = await loadConfig(configPath);

    assert.equal(config.providers.default.plan_model, "plan-alias");
    assert.deepEqual(config.providers.default.model_aliases, { "default-alias": "gpt-default", "plan-alias": "gpt-plan" });
    assert.deepEqual(config.providers.default.context_windows, { "gpt-default": 128000 });
  });

});

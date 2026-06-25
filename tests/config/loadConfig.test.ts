import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

  it("loads plan and complete node modes", async () => {
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
        mode: plan
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

    assert.equal(config.workflows.delivery.nodes[0]?.mode, "plan");
    assert.equal(config.workflows.delivery.nodes[1]?.mode, "complete");
  });

  it("keeps the bundled example workflow free of user_acceptance nodes", async () => {
    const config = await loadConfig("agent-team.example.yaml");
    const workflow = config.workflows.delivery;

    assert.equal(config.roles.user_acceptance, undefined);
    assert.equal(workflow.nodes.some((node) => node.id === "user_acceptance" || node.role === "user_acceptance"), false);
    assert.equal(workflow.nodes.find((node) => node.id === "product")?.mode, "plan");
    assert.equal(workflow.nodes.find((node) => node.id === "final_delivery")?.mode, "complete");
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
});

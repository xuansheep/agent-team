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
    assert.equal(config.workflows.delivery.nodes[0].id, "product");
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

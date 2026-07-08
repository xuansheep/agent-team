import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("skill config", () => {
  it("parses explicit skill paths from agent-team.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-skill-config-"));
    const file = join(dir, "agent-team.yaml");
    await writeFile(file, `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: default-model
skills:
  paths:
    - .agent-skills
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
`, "utf8");

    const config = await loadConfig(file, { cwd: dir });

    assert.deepEqual(config.skills?.paths, [".agent-skills"]);
  });
});

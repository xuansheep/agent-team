import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";
import { settingsSchema } from "../../src/settings/types.js";
import { writeProjectConfig } from "../helpers/projectConfig.js";

describe("skill config", () => {
  it("does not expose project skill-path configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-team-skill-config-"));
    const configDir = await writeProjectConfig(dir);

    const settings = settingsSchema.parse({ providers: { default: {
      type: "responses-api", responses: { prompt_cache: true, parallel_tool_calls: true },
      base_url: "https://api.example.test/v1",
      api_key: "test-key",
      default_model: "gpt-test"
    } } });
    const config = await loadConfig(configDir, { cwd: dir, settings });

    assert.equal(Object.hasOwn(config, "skills"), false);
  });
});

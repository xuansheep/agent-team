import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { defaultUserSettingsPath, legacyUserSettingsPath } from "../../src/settings/loadSettings.js";
import { resolveSettings } from "../../src/settings/resolveSettings.js";
import { settingsSchema } from "../../src/settings/types.js";

describe("hook settings", () => {
  it("uses ~/.einsteins/settings.yaml as the default user settings path", () => {
    assert.equal(defaultUserSettingsPath(), join(homedir(), ".einsteins", "settings.yaml"));
    assert.equal(legacyUserSettingsPath(), join(homedir(), ".agent-team", "settings.yaml"));
  });

  it("parses and merges user and project hooks", () => {
    const parsed = settingsSchema.parse({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }]
      }
    });

    const settings = resolveSettings({
      cwd: process.cwd(),
      userSettings: parsed,
      projectSettings: {
        hooks: {
          Stop: [{ matcher: "Write", hooks: [{ type: "prompt", prompt: "verify" }] }]
        }
      }
    });

    assert.equal(settings.hooks?.Stop?.length, 2);
  });
});

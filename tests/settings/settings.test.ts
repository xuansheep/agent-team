import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";
import { getPlanFilePath } from "../../src/plans/planFiles.js";
import { loadSettings } from "../../src/settings/loadSettings.js";
import { resolveSettings } from "../../src/settings/resolveSettings.js";
import { settingsSchema } from "../../src/settings/types.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-settings-"));
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

describe("settings", () => {
  it("loads user and project settings with project settings taking precedence", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user-settings.yaml");
    const projectSettingsPath = join(cwd, ".agent-team", "settings.yaml");
    await writeText(userSettingsPath, `
permissions:
  defaultMode: default
plansDirectory: .session/user-plans
models:
  planModel: user-plan
  aliases:
    shared: user-model
    user-only: user-model
  contextWindows:
    shared-model: 1000
planMode:
  defaultEntry: false
useAutoModeDuringPlan: true
showClearContextOnPlanAccept: false
`);
    await writeText(projectSettingsPath, `
permissions:
  defaultMode: acceptEdits
plansDirectory: .agent-team/plans
models:
  planModel: project-plan
  aliases:
    shared: project-model
  contextWindows:
    shared-model: 2000
planMode:
  defaultEntry: true
useAutoModeDuringPlan: false
showClearContextOnPlanAccept: true
`);

    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });

    assert.equal(settings.permissions?.defaultMode, "acceptEdits");
    assert.equal(settings.plansDirectory, resolve(cwd, ".agent-team", "plans"));
    assert.equal(settings.models?.planModel, "project-plan");
    assert.deepEqual(settings.models?.aliases, { shared: "project-model", "user-only": "user-model" });
    assert.deepEqual(settings.models?.contextWindows, { "shared-model": 2000 });
    assert.equal(settings.planMode?.defaultEntry, true);
    assert.equal(settings.useAutoModeDuringPlan, true);
    assert.equal(settings.showClearContextOnPlanAccept, true);
  });

  it("ignores project useAutoModeDuringPlan settings", () => {
    const cwd = resolve(".");

    assert.equal(resolveSettings({ cwd, projectSettings: { useAutoModeDuringPlan: false } }).useAutoModeDuringPlan, undefined);
    assert.equal(
      resolveSettings({
        cwd,
        userSettings: { useAutoModeDuringPlan: true },
        projectSettings: { useAutoModeDuringPlan: false }
      }).useAutoModeDuringPlan,
      true
    );
  });

  it("rejects legacy session mode keys but allows Plan Mode defaults", () => {
    assert.throws(() => settingsSchema.parse({ permissionMode: "plan" }), /Unrecognized key/);
    assert.throws(() => settingsSchema.parse({ permissions: { mode: "plan" } }), /Unrecognized key/);
    assert.equal(settingsSchema.parse({ permissions: { defaultMode: "plan" } }).permissions?.defaultMode, "plan");
    assert.equal(settingsSchema.parse({ useAutoModeDuringPlan: false }).useAutoModeDuringPlan, false);
  });

  it("requires plansDirectory to stay within the project root", async () => {
    const cwd = await workspace();

    assert.equal(
      resolveSettings({ cwd, projectSettings: { plansDirectory: ".agent-team/plans" } }).plansDirectory,
      resolve(cwd, ".agent-team", "plans")
    );
    assert.throws(() => resolveSettings({ cwd, projectSettings: { plansDirectory: "../outside" } }), /within project root/);
    assert.throws(() => resolveSettings({ cwd, projectSettings: { plansDirectory: resolve(cwd, "..", "outside") } }), /within project root/);
  });

  it("uses configured plan directory for plan file paths", async () => {
    const cwd = await workspace();
    const settings = resolveSettings({ cwd, projectSettings: { plansDirectory: ".agent-team/plans" } });

    assert.match(getPlanFilePath("session-1", cwd, settings.plansDirectory), /[.]agent-team[\\/]plans[\\/].+[.]md$/);
  });

  it("does not let permission defaults change workflow YAML node semantics", async () => {
    const cwd = await workspace();
    const configPath = join(cwd, "agent-team.yaml");
    await writeText(configPath, `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: default-model
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

    const settings = resolveSettings({ cwd, projectSettings: { permissions: { defaultMode: "plan" }, planMode: { defaultEntry: true } } });
    const config = await loadConfig(configPath, { cwd, settings });
    const node = config.workflows.delivery.nodes[0];

    assert.equal(node.mode, "task");
    assert.equal(node.permission_mode, "default");
  });

  it("merges settings model metadata into provider config with settings precedence", async () => {
    const cwd = await workspace();
    const configPath = join(cwd, "agent-team.yaml");
    await writeText(configPath, `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: quick
    plan_model: config-plan
    model_aliases:
      legacy: legacy-model
      shared: config-model
    context_windows:
      legacy-model: 1000
      shared-model: 2000
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

    const settings = resolveSettings({
      cwd,
      projectSettings: {
        models: {
          planModel: "settings-plan",
          aliases: { quick: "settings-model", shared: "settings-shared-model" },
          contextWindows: { "settings-model": 128000, "shared-model": 32000 }
        }
      }
    });
    const config = await loadConfig(configPath, { cwd, settings });
    const provider = config.providers.default;

    assert.equal(provider.plan_model, "settings-plan");
    assert.deepEqual(provider.model_aliases, { legacy: "legacy-model", shared: "settings-shared-model", quick: "settings-model" });
    assert.deepEqual(provider.context_windows, { "legacy-model": 1000, "shared-model": 32000, "settings-model": 128000 });
  });
});

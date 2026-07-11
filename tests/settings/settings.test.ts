import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";
import { getPlanFilePath } from "../../src/plans/planFiles.js";
import { defaultUserSettingsPath, loadSettings, setUserDefaultPermissionMode } from "../../src/settings/loadSettings.js";
import { resolveSettings } from "../../src/settings/resolveSettings.js";
import { settingsSchema } from "../../src/settings/types.js";
import { writeProjectConfig } from "../helpers/projectConfig.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-settings-"));
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

describe("settings", () => {
  it("creates the user settings template once without overwriting it", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "home", ".einsteins", "settings.yaml");
    const projectSettingsPath = join(cwd, "project-settings.yaml");

    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });
    const generated = await readFile(userSettingsPath, "utf8");

    assert.deepEqual(Object.keys(settings.providers ?? {}), ["default", "openai_compatible", "anthropic"]);
    assert.match(generated, /api_key: ""/);
    if (process.platform !== "win32") assert.equal((await stat(userSettingsPath)).mode & 0o777, 0o600);

    await writeFile(userSettingsPath, "permissions:\n  defaultMode: plan\n", "utf8");
    await loadSettings({ cwd, userSettingsPath, projectSettingsPath });
    assert.equal(await readFile(userSettingsPath, "utf8"), "permissions:\n  defaultMode: plan\n");
  });

  it("rejects providers in project settings", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user-settings.yaml");
    const projectSettingsPath = join(cwd, ".einsteins", "settings.yaml");
    await writeText(userSettingsPath, "providers: {}\n");
    await writeText(projectSettingsPath, "providers: {}\n");

    await assert.rejects(
      () => loadSettings({ cwd, userSettingsPath, projectSettingsPath }),
      /Project settings cannot define providers/
    );
  });

  it("persists the user default permission mode without losing provider settings", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "home", ".einsteins", "settings.yaml");
    const projectSettingsPath = join(cwd, "project-settings.yaml");
    await writeText(userSettingsPath, `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key: preserved-key
    default_model: gpt-test
permissions:
  defaultMode: default
`);

    await setUserDefaultPermissionMode("fullAccess", userSettingsPath);
    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });

    assert.equal(settings.permissions?.defaultMode, "fullAccess");
    assert.equal(settings.providers?.default?.api_key, "preserved-key");
  });

  it("rejects provider environment variable keys", () => {
    assert.throws(() => settingsSchema.parse({ providers: { default: {
      type: "openai-compatible",
      base_url: "https://api.example.test/v1",
      api_key_env: "OPENAI_API_KEY",
      default_model: "gpt-test"
    } } }), /api_key/);
  });

  it("loads user and project settings with project settings taking precedence", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user-settings.yaml");
    const projectSettingsPath = join(cwd, ".einsteins", "settings.yaml");
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
showClearContextOnPlanAccept: false
`);
    await writeText(projectSettingsPath, `
permissions:
  defaultMode: fullAccess
plansDirectory: .einsteins/plans
models:
  planModel: project-plan
  aliases:
    shared: project-model
  contextWindows:
    shared-model: 2000
planMode:
  defaultEntry: true
showClearContextOnPlanAccept: true
`);

    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });

    assert.equal(settings.permissions?.defaultMode, "fullAccess");
    assert.equal(settings.plansDirectory, resolve(cwd, ".einsteins", "plans"));
    assert.equal(settings.models?.planModel, "project-plan");
    assert.deepEqual(settings.models?.aliases, { shared: "project-model", "user-only": "user-model" });
    assert.deepEqual(settings.models?.contextWindows, { "shared-model": 2000 });
    assert.equal(settings.planMode?.defaultEntry, true);
    assert.equal(settings.showClearContextOnPlanAccept, true);
  });

  it("rejects legacy session mode keys but allows Plan Mode defaults", () => {
    assert.throws(() => settingsSchema.parse({ permissionMode: "plan" }), /Unrecognized key/);
    assert.throws(() => settingsSchema.parse({ permissions: { mode: "plan" } }), /Unrecognized key/);
    assert.equal(settingsSchema.parse({ permissions: { defaultMode: "plan" } }).permissions?.defaultMode, "plan");
  });

  it("accepts only current settings permission defaults", () => {
    assert.equal(settingsSchema.parse({ permissions: { defaultMode: "default" } }).permissions?.defaultMode, "default");
    assert.equal(settingsSchema.parse({ permissions: { defaultMode: "fullAccess" } }).permissions?.defaultMode, "fullAccess");
    assert.equal(settingsSchema.parse({ permissions: { defaultMode: "plan" } }).permissions?.defaultMode, "plan");
    for (const defaultMode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
      assert.throws(() => settingsSchema.parse({ permissions: { defaultMode } }), /Invalid enum value/);
    }
  });

  it("requires plansDirectory to stay within the project root", async () => {
    const cwd = await workspace();

    assert.equal(
      resolveSettings({ cwd, projectSettings: { plansDirectory: ".einsteins/plans" } }).plansDirectory,
      resolve(cwd, ".einsteins", "plans")
    );
    assert.throws(() => resolveSettings({ cwd, projectSettings: { plansDirectory: "../outside" } }), /within project root/);
    assert.throws(() => resolveSettings({ cwd, projectSettings: { plansDirectory: resolve(cwd, "..", "outside") } }), /within project root/);
  });

  it("uses configured plan directory for plan file paths", async () => {
    const cwd = await workspace();
    const settings = resolveSettings({ cwd, projectSettings: { plansDirectory: ".einsteins/plans" } });

    assert.match(getPlanFilePath("session-1", cwd, settings.plansDirectory), /[.]einsteins[\\/]plans[\\/].+[.]md$/);
  });

  it("does not let permission defaults change workflow node semantics", async () => {
    const cwd = await workspace();
    const configPath = await writeProjectConfig(cwd);

    const settings = resolveSettings({
      cwd,
      userSettings: settingsSchema.parse({ providers: { default: {
        type: "openai-compatible",
        base_url: "https://api.example.test/v1",
        api_key: "test-key",
        default_model: "default-model"
      } } }),
      projectSettings: { permissions: { defaultMode: "plan" }, planMode: { defaultEntry: true } }
    });
    const config = await loadConfig(configPath, { cwd, settings });
    const node = config.workflows.delivery.nodes[0];

    assert.equal(node.mode, "task");
    assert.equal(node.permission_mode, "default");
  });

  it("merges settings model metadata into provider config with settings precedence", async () => {
    const cwd = await workspace();
    const configPath = await writeProjectConfig(cwd);

    const settings = resolveSettings({
      cwd,
      userSettings: settingsSchema.parse({ providers: { default: {
        type: "openai-compatible",
        base_url: "https://api.example.test/v1",
        api_key: "test-key",
        default_model: "quick",
        plan_model: "config-plan",
        model_aliases: { legacy: "legacy-model", shared: "config-model" },
        context_windows: { "legacy-model": 1000, "shared-model": 2000 }
      } } }),
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

  it("defaults user settings to ~/.einsteins", () => {
    assert.match(defaultUserSettingsPath(), /[\\/]\.einsteins[\\/]settings\.yaml$/);
  });

});

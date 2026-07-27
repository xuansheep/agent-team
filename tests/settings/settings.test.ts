import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";
import { getPlanFilePath } from "../../src/plans/planFiles.js";
import { defaultUserSettingsPath, loadSettings, setUserDefaultPermissionMode, setUserStatusLineElements } from "../../src/settings/loadSettings.js";
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + "\n");
}

function provider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "openai-compatible",
    base_url: "https://api.example.test/v1",
    api_key: "test-key",
    default_model: "gpt-test",
    ...overrides
  };
}

describe("settings", () => {
  it("creates the JSON user settings template once without overwriting it", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "home", ".einsteins", "settings.json");
    const projectSettingsPath = join(cwd, "project-settings.json");

    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });
    const generated = await readFile(userSettingsPath, "utf8");
    const parsed = JSON.parse(generated) as {
      statusLine: string[];
      models: { defaultContextWindow: number };
      providers: Record<string, { api_key: string; effort: string }>;
    };

    assert.deepEqual(Object.keys(settings.providers ?? {}), ["default", "openai_compatible", "anthropic"]);
    assert.deepEqual(parsed.statusLine, ["run-state", "permission", "current-dir", "git-branch", "tokens-io", "tokens-cache", "run-id", "selection"]);
    assert.equal(parsed.models.defaultContextWindow, 272000);
    assert.equal(Object.hasOwn(parsed.models, "defaultContextCompression"), false);
    assert.equal(parsed.providers.default.api_key, "");
    assert.equal(parsed.providers.default.effort, "medium");
    assert.equal(parsed.providers.openai_compatible.effort, "medium");
    assert.equal(parsed.providers.anthropic.effort, "medium");
    if (process.platform !== "win32") assert.equal((await stat(userSettingsPath)).mode & 0o777, 0o600);

    await writeJson(userSettingsPath, { permissions: { defaultMode: "plan" } });
    await loadSettings({ cwd, userSettingsPath, projectSettingsPath });
    assert.deepEqual(JSON.parse(await readFile(userSettingsPath, "utf8")), { permissions: { defaultMode: "plan" } });
  });

  it("rejects providers in project settings", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user-settings.json");
    const projectSettingsPath = join(cwd, ".einsteins", "settings.json");
    await writeJson(userSettingsPath, { providers: {} });
    await writeJson(projectSettingsPath, { providers: {} });

    await assert.rejects(
      () => loadSettings({ cwd, userSettingsPath, projectSettingsPath }),
      /Project settings cannot define providers/
    );
  });

  it("persists the user default permission mode without losing provider settings", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "home", ".einsteins", "settings.json");
    const projectSettingsPath = join(cwd, "project-settings.json");
    await writeJson(userSettingsPath, {
      providers: { default: provider({ api_key: "preserved-key", effort: "provider-custom" }) },
      permissions: { defaultMode: "default" },
      mcpServers: {
        docs: { type: "http", url: "${DOCS_MCP_URL}", headers: { Authorization: "Bearer ${DOCS_MCP_TOKEN}" } }
      },
      projects: {
        [resolve(cwd)]: { disabledMcpServers: ["docs"] }
      }
    });

    await setUserDefaultPermissionMode("fullAccess", userSettingsPath);
    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });
    const stored = JSON.parse(await readFile(userSettingsPath, "utf8"));

    assert.equal(settings.permissions?.defaultMode, "fullAccess");
    assert.equal(settings.providers?.default?.api_key, "preserved-key");
    assert.equal(settings.providers?.default?.effort, "provider-custom");
    assert.equal(stored.mcpServers.docs.url, "${DOCS_MCP_URL}");
    assert.equal(stored.mcpServers.docs.headers.Authorization, "Bearer ${DOCS_MCP_TOKEN}");
    assert.deepEqual(stored.projects[resolve(cwd)].disabledMcpServers, ["docs"]);
  });

  it("persists ordered user statusline elements without losing unrelated settings", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "home", ".einsteins", "settings.json");
    const projectSettingsPath = join(cwd, "project-settings.json");
    await writeJson(userSettingsPath, {
      providers: { default: provider({ api_key: "preserved-key" }) },
      permissions: { defaultMode: "fullAccess" }
    });

    await setUserStatusLineElements(["git-branch", "current-dir", "permission"], userSettingsPath);
    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });
    const stored = JSON.parse(await readFile(userSettingsPath, "utf8"));

    assert.deepEqual(settings.statusLine, ["git-branch", "current-dir", "permission"]);
    assert.deepEqual(stored.statusLine, ["git-branch", "current-dir", "permission"]);
    assert.equal(stored.providers.default.api_key, "preserved-key");
    assert.equal(stored.permissions.defaultMode, "fullAccess");

    await setUserStatusLineElements([], userSettingsPath);
    assert.deepEqual(JSON.parse(await readFile(userSettingsPath, "utf8")).statusLine, []);
  });

  it("filters removed statusline elements while rejecting invalid, duplicate, and project-level settings", async () => {
    assert.throws(() => settingsSchema.parse({ statusLine: ["run"] }), /Invalid enum value/);
    assert.deepEqual(
      settingsSchema.parse({ statusLine: ["mode", "run-state", "work-mode", "loading", "permission"] }).statusLine,
      ["run-state", "permission"]
    );
    assert.throws(() => settingsSchema.parse({ statusLine: ["run-state", "run-state"] }), /Status line elements must be unique/);

    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user-settings.json");
    const projectSettingsPath = join(cwd, "project-settings.json");
    await writeJson(userSettingsPath, {});
    await writeJson(projectSettingsPath, { statusLine: ["mode"] });
    await assert.rejects(
      () => loadSettings({ cwd, userSettingsPath, projectSettingsPath }),
      /Unrecognized key/
    );
  });

  it("rejects YAML content instead of applying legacy compatibility", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "settings.json");
    await writeText(userSettingsPath, "providers: {}\n");

    await assert.rejects(
      () => loadSettings({ cwd, userSettingsPath, projectSettingsPath: join(cwd, "project.json") }),
      /Invalid JSON settings.*settings\.json/
    );
  });

  it("reports invalid project JSON with its path", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user.json");
    const projectSettingsPath = join(cwd, "project.json");
    await writeJson(userSettingsPath, {});
    await writeText(projectSettingsPath, "{ invalid");

    await assert.rejects(
      () => loadSettings({ cwd, userSettingsPath, projectSettingsPath }),
      /Invalid JSON settings.*project\.json/
    );
  });

  it("accepts arbitrary non-empty provider effort and rejects duplicate Responses reasoning effort", () => {
    const parsed = settingsSchema.parse({ providers: { default: provider({ effort: "custom-reasoning-level" }) } });
    assert.equal(parsed.providers?.default?.effort, "custom-reasoning-level");
    assert.throws(() => settingsSchema.parse({ providers: { default: provider({ effort: " " }) } }));
    assert.throws(() => settingsSchema.parse({
      providers: {
        default: {
          type: "responses-api",
          base_url: "https://api.example.test/v1",
          api_key: "test-key",
          default_model: "gpt-test",
          responses: { reasoning: { effort: "high" } }
        }
      }
    }), /Unrecognized key/);
  });

  it("accepts provider retry overrides and validates their bounds", () => {
    const parsed = settingsSchema.parse({ providers: { default: provider({
      request_max_retries: 0,
      stream_max_retries: 25,
      request_timeout_ms: 1_000,
      stream_idle_timeout_ms: 500
    }) } });
    assert.equal(parsed.providers?.default?.request_max_retries, 0);
    assert.equal(parsed.providers?.default?.stream_max_retries, 25);
    assert.throws(() => settingsSchema.parse({ providers: { default: provider({ request_max_retries: 101 }) } }));
    assert.throws(() => settingsSchema.parse({ providers: { default: provider({ stream_idle_timeout_ms: 0 }) } }));
  });

  it("rejects provider environment variable keys", () => {
    assert.throws(() => settingsSchema.parse({ providers: { default: {
      type: "openai-compatible",
      base_url: "https://api.example.test/v1",
      api_key_env: "OPENAI_API_KEY",
      default_model: "gpt-test"
    } } }), /api_key/);
  });

  it("strictly rejects removed model compression settings", () => {
    assert.throws(() => settingsSchema.parse({ models: { defaultContextCompression: 258000 } }), /Unrecognized key/);
    assert.throws(() => settingsSchema.parse({ models: { contextCompression: { "gpt-test": 251000 } } }), /Unrecognized key/);
  });

  it("loads JSON user and project settings with project settings taking precedence", async () => {
    const cwd = await workspace();
    const userSettingsPath = join(cwd, "user-settings.json");
    const projectSettingsPath = join(cwd, ".einsteins", "settings.json");
    await writeJson(userSettingsPath, {
      permissions: { defaultMode: "default" },
      plansDirectory: ".session/user-plans",
      models: {
        planModel: "user-plan",
        defaultContextWindow: 111000,
        aliases: { shared: "user-model", "user-only": "user-model" },
        contextWindows: { "shared-model": 1000, "user-only-model": 3000 },
        autoCompactTokenLimits: { "shared-model": 900, "user-only-model": 2500 },
        compactionHashes: { "shared-model": "user-hash", "user-only-model": "user-only-hash" },
      },
      planMode: { defaultEntry: false },
      copyOnSelect: true,
      showClearContextOnPlanAccept: false,
      mcpServers: { shared: { type: "stdio", command: "user" } }
    });
    await writeJson(projectSettingsPath, {
      permissions: { defaultMode: "fullAccess" },
      plansDirectory: ".einsteins/plans",
      models: {
        planModel: "project-plan",
        defaultContextWindow: 222000,
        aliases: { shared: "project-model" },
        contextWindows: { "shared-model": 2000 },
        autoCompactTokenLimits: { "shared-model": 1800 },
        compactionHashes: { "shared-model": "project-hash" },
      },
      planMode: { defaultEntry: true },
      copyOnSelect: false,
      showClearContextOnPlanAccept: true,
      mcpServers: { shared: { type: "stdio", command: "project" } }
    });

    const settings = await loadSettings({ cwd, userSettingsPath, projectSettingsPath });

    assert.equal(settings.permissions?.defaultMode, "fullAccess");
    assert.equal(settings.plansDirectory, resolve(cwd, ".einsteins", "plans"));
    assert.equal(settings.models?.planModel, "project-plan");
    assert.equal(settings.models?.defaultContextWindow, 222000);
    assert.deepEqual(settings.models?.aliases, { shared: "project-model", "user-only": "user-model" });
    assert.deepEqual(settings.models?.contextWindows, { "shared-model": 2000, "user-only-model": 3000 });
    assert.deepEqual(settings.models?.autoCompactTokenLimits, { "shared-model": 1800, "user-only-model": 2500 });
    assert.deepEqual(settings.models?.compactionHashes, { "shared-model": "project-hash", "user-only-model": "user-only-hash" });
    assert.equal(settings.planMode?.defaultEntry, true);
    assert.equal(settings.copyOnSelect, false);
    assert.equal(settings.showClearContextOnPlanAccept, true);
    assert.equal(Object.hasOwn(settings, "mcpServers"), false);
    assert.equal(Object.hasOwn(settings, "projects"), false);
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
      userSettings: settingsSchema.parse({ providers: { default: provider({ default_model: "default-model" }) } }),
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
      userSettings: settingsSchema.parse({ providers: { default: provider({
        default_model: "quick",
        plan_model: "config-plan",
        model_aliases: { legacy: "legacy-model", shared: "config-model" },
        context_windows: { "legacy-model": 1000, "shared-model": 2000 },
        default_context_window: 64000
      }) } }),
      projectSettings: {
        models: {
          planModel: "settings-plan",
          defaultContextWindow: 272000,
          aliases: { quick: "settings-model", shared: "settings-shared-model" },
          contextWindows: { "settings-model": 128000, "shared-model": 32000 },
          defaultAutoCompactTokenLimit: 240000,
          autoCompactTokenLimits: { "settings-model": 110000 },
          compactionHashes: { "settings-model": "hash-v2" },
          autoCompactTokenLimitScope: "body_after_prefix",
          toolOutputTokenLimit: 4000,
          compactPrompt: "custom compact prompt"
        }
      }
    });
    const config = await loadConfig(configPath, { cwd, settings });
    const resolvedProvider = config.providers.default;

    assert.equal(resolvedProvider.plan_model, "settings-plan");
    assert.equal(resolvedProvider.default_context_window, 272000);
    assert.deepEqual(resolvedProvider.model_aliases, { legacy: "legacy-model", shared: "settings-shared-model", quick: "settings-model" });
    assert.deepEqual(resolvedProvider.context_windows, { "legacy-model": 1000, "shared-model": 32000, "settings-model": 128000 });
    assert.equal(resolvedProvider.default_auto_compact_token_limit, 240000);
    assert.deepEqual(resolvedProvider.auto_compact_token_limits, { "settings-model": 110000 });
    assert.deepEqual(resolvedProvider.compaction_hashes, { "settings-model": "hash-v2" });
    assert.equal(resolvedProvider.auto_compact_token_limit_scope, "body_after_prefix");
    assert.equal(resolvedProvider.tool_output_token_limit, 4000);
    assert.equal(resolvedProvider.compact_prompt, "custom compact prompt");
  });

  it("defaults user settings to ~/.einsteins/settings.json", () => {
    assert.match(defaultUserSettingsPath(), /[\\/]\.einsteins[\\/]settings\.json$/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_USER_SETTINGS } from "../../src/settings/loadSettings.js";
import { prepareTuiRuntime } from "../../src/tui/launchTui.js";
import { writeProjectConfig } from "../helpers/projectConfig.js";


describe("TUI startup workflow selection", () => {
  it("initializes user config without committing a workflow selection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-no-project-config-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-tui-home-"));
    const runtime = await prepareTuiRuntime({ cwd, homeDir });

    assert.match(runtime.config.roles.developer.system_prompt, /development node/);
    assert.equal(runtime.config.workflows.delivery.nodes[0]?.role, "product");
    assert.deepEqual(runtime.workflows, ["delivery"]);
    assert.equal("workflowId" in runtime, false);
    const settings = JSON.parse(await readFile(join(homeDir, ".einsteins", "settings.json"), "utf8")) as { providers: { default: Record<string, unknown> } };
    assert.deepEqual(Object.keys(settings), ["providers"]);
    assert.deepEqual(Object.keys(settings.providers.default), ["type", "base_url", "api_key", "default_model"]);
    assert.equal(runtime.config.providers.default.effort, "medium");
    assert.equal(runtime.promptHistoryStore.path, join(homeDir, ".einsteins", "history.jsonl"));
    assert.deepEqual(runtime.promptHistoryStore.entries, []);
  });

  it("loads disabled MCP servers from user and project settings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-mcp-settings-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-tui-home-"));
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-tui-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot);
    await mkdir(join(homeDir, ".einsteins"), { recursive: true });
    await mkdir(join(cwd, ".einsteins"), { recursive: true });
    await writeFile(join(homeDir, ".einsteins", "settings.json"), JSON.stringify({
      ...JSON.parse(DEFAULT_USER_SETTINGS),
      mcpServers: {
        shared: { type: "stdio", command: "user", disabled: true },
        userOnly: { type: "stdio", command: "user-only", disabled: true }
      }
    }), "utf8");
    await writeFile(join(cwd, ".einsteins", "settings.json"), JSON.stringify({
      mcpServers: {
        shared: { type: "stdio", command: "project", disabled: true }
      }
    }), "utf8");

    const runtime = await prepareTuiRuntime({ cwd, homeDir, templateConfigDir });

    assert.equal(runtime.diagnostics.mcp.find((server) => server.name === "shared")?.source, "project");
    assert.equal(runtime.diagnostics.mcp.find((server) => server.name === "userOnly")?.source, "user");
  });

  it("discovers project skills during bootstrap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-skills-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-tui-home-"));
    await mkdir(join(cwd, ".git"), { recursive: true });
    await mkdir(join(cwd, ".einsteins", "skills", "reviewer"), { recursive: true });
    await writeFile(join(cwd, ".einsteins", "skills", "reviewer", "SKILL.md"), `---
name: reviewer
---
Review carefully.
`, "utf8");
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-tui-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot);
    await mkdir(join(homeDir, ".einsteins"), { recursive: true });
    await writeFile(join(homeDir, ".einsteins", "settings.json"), JSON.stringify({
      ...JSON.parse(DEFAULT_USER_SETTINGS),
      projects: { [cwd]: { disabledSkills: ["reviewer"] } }
    }), "utf8");

    const runtime = await prepareTuiRuntime({ cwd, homeDir, templateConfigDir });

    assert.equal(runtime.skillRuntime.getSkill("reviewer"), undefined);
    assert.equal(runtime.diagnostics.skills.find((skill) => skill.name === "reviewer")?.source, "project");
    assert.equal(runtime.diagnostics.skills.find((skill) => skill.name === "reviewer")?.disabled, true);
    const settings = JSON.parse(await readFile(join(homeDir, ".einsteins", "settings.json"), "utf8")) as { providers: { default: Record<string, unknown> } };
    assert.deepEqual(Object.keys(settings.providers.default), ["type", "base_url", "api_key", "default_model"]);
    assert.equal(runtime.config.providers.default.effort, "medium");
  });

  it("ignores project roles, workflows, and prompt after user initialization", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-project-config-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-tui-home-"));
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-tui-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot, {
      prompt: "Bundled prompt.",
      roles: { global_dev: { system_prompt: "Global role." } },
      workflows: { global_flow: { nodes: [{ id: "global_dev", role: "global_dev", provider: "default" }] } }
    });
    await writeProjectConfig(cwd, {
      prompt: "Project prompt.",
      roles: { project_dev: { system_prompt: "Project role." } },
      workflows: { project_flow: { nodes: [{ id: "project_dev", role: "project_dev", provider: "default" }] } }
    });

    const runtime = await prepareTuiRuntime({ cwd, homeDir, templateConfigDir });

    assert.deepEqual(Object.keys(runtime.config.roles), ["global_dev"]);
    assert.deepEqual(Object.keys(runtime.config.workflows), ["global_flow"]);
    assert.match(runtime.config.global_prompt ?? "", /Bundled prompt/);
    assert.doesNotMatch(runtime.config.global_prompt ?? "", /Project prompt/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBundledConfigDir, ensureUserRoleWorkflowConfig } from "../../src/config/userConfig.js";
import { writeProjectConfig } from "../helpers/projectConfig.js";

describe("user role, workflow, and team initialization", () => {
  it("locates bundled templates from the package root", () => {
    assert.equal(defaultBundledConfigDir(), resolve("config"));
  });

  it("initializes roles, workflows, and teams when the user config root is absent", async () => {
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot, {
      roles: { dev: { system_prompt: "Template role." } },
      workflows: { delivery: { nodes: [{ id: "dev", role: "dev", provider: "default" }] } },
      teams: { support: { nodes: [{ id: "dev", role: "dev", provider: "default" }] } }
    });
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-user-home-"));
    const userConfigDir = join(homeDir, ".einsteins");

    await ensureUserRoleWorkflowConfig({ userConfigDir, templateConfigDir });

    assert.match(await readFile(join(userConfigDir, "roles", "dev.md"), "utf8"), /Template role/);
    assert.match(await readFile(join(userConfigDir, "workflows", "delivery.json"), "utf8"), /"name": "delivery"/);
    assert.match(await readFile(join(userConfigDir, "teams", "support.json"), "utf8"), /"name": "support"/);
    await assert.rejects(() => readFile(join(userConfigDir, "prompt.md"), "utf8"), { code: "ENOENT" });
  });

  it("fills missing role, workflow, and team directories for an existing settings-only user", async () => {
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot);
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-existing-home-"));
    const userConfigDir = join(homeDir, ".einsteins");
    await mkdir(userConfigDir, { recursive: true });
    await writeFile(join(userConfigDir, "settings.json"), "{\"providers\":{}}\n", "utf8");

    await ensureUserRoleWorkflowConfig({ userConfigDir, templateConfigDir });

    assert.deepEqual(await readdir(join(userConfigDir, "roles")), ["dev.md"]);
    assert.deepEqual(await readdir(join(userConfigDir, "workflows")), ["delivery.json"]);
    assert.deepEqual(await readdir(join(userConfigDir, "teams")), ["team.json"]);
    assert.equal(await readFile(join(userConfigDir, "settings.json"), "utf8"), "{\"providers\":{}}\n");
  });

  it("preserves an existing role directory while initializing a missing workflow directory", async () => {
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot);
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-custom-home-"));
    const userConfigDir = join(homeDir, ".einsteins");
    await mkdir(join(userConfigDir, "roles"), { recursive: true });
    await writeFile(join(userConfigDir, "roles", "custom.md"), "custom role\n", "utf8");

    await ensureUserRoleWorkflowConfig({ userConfigDir, templateConfigDir });

    assert.deepEqual(await readdir(join(userConfigDir, "roles")), ["custom.md"]);
    assert.equal(await readFile(join(userConfigDir, "roles", "custom.md"), "utf8"), "custom role\n");
    assert.deepEqual(await readdir(join(userConfigDir, "workflows")), ["delivery.json"]);
    assert.deepEqual(await readdir(join(userConfigDir, "teams")), ["team.json"]);
  });

  it("does not merge or overwrite existing role and workflow directories", async () => {
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot);
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-custom-home-"));
    const userConfigDir = join(homeDir, ".einsteins");
    await mkdir(join(userConfigDir, "roles"), { recursive: true });
    await mkdir(join(userConfigDir, "workflows"), { recursive: true });
    await writeFile(join(userConfigDir, "roles", "custom.md"), "custom role\n", "utf8");
    await writeFile(join(userConfigDir, "workflows", "custom.json"), "{}\n", "utf8");

    await ensureUserRoleWorkflowConfig({ userConfigDir, templateConfigDir });

    assert.deepEqual(await readdir(join(userConfigDir, "roles")), ["custom.md"]);
    assert.deepEqual(await readdir(join(userConfigDir, "workflows")), ["custom.json"]);
    assert.deepEqual(await readdir(join(userConfigDir, "teams")), ["team.json"]);
  });

  it("reports a missing bundled template before copying either directory", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-user-home-"));
    const userConfigDir = join(homeDir, ".einsteins");
    const templateConfigDir = join(homeDir, "missing-template");

    await assert.rejects(
      () => ensureUserRoleWorkflowConfig({ userConfigDir, templateConfigDir }),
      new RegExp(`Missing bundled config template directory: .*(roles|workflows|teams)`)
    );
    assert.deepEqual(await readdir(userConfigDir), []);
  });

  it("rejects a user role path that is not a directory", async () => {
    const templateRoot = await mkdtemp(join(tmpdir(), "agent-team-template-"));
    const templateConfigDir = await writeProjectConfig(templateRoot);
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-user-home-"));
    const userConfigDir = join(homeDir, ".einsteins");
    await mkdir(userConfigDir, { recursive: true });
    await writeFile(join(userConfigDir, "roles"), "not a directory\n", "utf8");

    await assert.rejects(
      () => ensureUserRoleWorkflowConfig({ userConfigDir, templateConfigDir }),
      /User config path must be a directory: .*roles/
    );
    assert.deepEqual(await readdir(userConfigDir), ["roles"]);
  });
});

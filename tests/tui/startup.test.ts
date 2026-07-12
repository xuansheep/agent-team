import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTuiRuntime, selectDefaultWorkflow } from "../../src/tui/launchTui.js";
import { writeProjectConfig } from "../helpers/projectConfig.js";


describe("TUI startup workflow selection", () => {

  it("prefers delivery workflow", () => {

    assert.equal(selectDefaultWorkflow(["other", "delivery"]), "delivery");

  });



  it("uses the only workflow when delivery is absent", () => {

    assert.equal(selectDefaultWorkflow(["single"]), "single");

  });



  it("requires selection when multiple non-delivery workflows exist", () => {
    assert.equal(selectDefaultWorkflow(["a", "b"]), undefined);
  });

  it("creates user settings before reporting a missing project config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-missing-config-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-tui-missing-home-"));

    await assert.rejects(() => prepareTuiRuntime({ cwd, homeDir }), /ENOENT/);
    assert.match(await readFile(join(homeDir, ".einsteins", "settings.yaml"), "utf8"), /providers:/);
  });

  it("discovers project skills during bootstrap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-skills-"));
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-tui-home-"));
    await mkdir(join(cwd, ".git"), { recursive: true });
    await mkdir(join(cwd, ".agents", "skills", "reviewer"), { recursive: true });
    await writeFile(join(cwd, ".agents", "skills", "reviewer", "SKILL.md"), `---
name: reviewer
---
Review carefully.
`, "utf8");
    await writeProjectConfig(cwd);

    const runtime = await prepareTuiRuntime({ cwd, homeDir });

    assert.equal(runtime.skillRuntime?.getSkill("reviewer")?.source, "project");
    assert.match(await readFile(join(homeDir, ".einsteins", "settings.yaml"), "utf8"), /providers:\s+[\s\S]*default:/);
  });

});

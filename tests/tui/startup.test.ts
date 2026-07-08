import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTuiRuntime, selectDefaultWorkflow } from "../../src/tui/launchTui.js";

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

  it("discovers configured project skills during bootstrap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-skills-"));
    await mkdir(join(cwd, "configured-skills", "reviewer"), { recursive: true });
    await writeFile(join(cwd, "configured-skills", "reviewer", "SKILL.md"), `---
name: reviewer
---
Review carefully.
`, "utf8");
    await writeFile(join(cwd, "agent-team.yaml"), `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: default-model
skills:
  paths:
    - configured-skills
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

    const runtime = await prepareTuiRuntime({ cwd });

    assert.equal(runtime.skillRuntime?.getSkill("reviewer")?.source, "project");
  });

  it("prepares hook runtime diagnostics from settings during bootstrap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-hooks-"));
    await mkdir(join(cwd, ".agent-team"), { recursive: true });
    await writeFile(join(cwd, ".agent-team", "settings.yaml"), `
hooks:
  Stop:
    - hooks:
        - type: command
          command: verify-stop
`, "utf8");
    await writeFile(join(cwd, "agent-team.yaml"), `
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
`, "utf8");

    const runtime = await prepareTuiRuntime({ cwd });

    assert.equal(runtime.hookRuntime.getDiagnostics()[0]?.command, "verify-stop");
    assert.equal(runtime.diagnostics.hooks[0]?.event, "Stop");
  });
});

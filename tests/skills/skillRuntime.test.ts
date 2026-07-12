import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { SkillRuntime } from "../../src/skills/runtime.js";
import { parseSkillMarkdown } from "../../src/skills/skillLoader.js";

describe("SkillRuntime", () => {
  it("discovers project and user skills with project precedence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-skill-runtime-"));
    const userRoot = await mkdtemp(join(tmpdir(), "agent-team-user-skills-"));
    await mkdir(join(cwd, ".git"));
    await writeSkill(join(userRoot, "shared"), "shared", "user");
    await writeSkill(join(userRoot, "user-only"), "user-only", "user-only");
    await writeSkill(join(cwd, ".agents", "skills", "project"), "project", "project");
    await writeSkill(join(cwd, ".agents", "skills", "shared"), "shared", "project-agents");
    await writeSkill(join(cwd, ".einsteins", "skills", "ignored"), "ignored", "old-project-path");

    const runtime = await SkillRuntime.discover({
      cwd,
      userSkillRoot: userRoot
    });

    assert.deepEqual(runtime.listSkills().map((skill) => `${skill.name}:${skill.source}`), [
      "project:project",
      "shared:project",
      "user-only:user"
    ]);
    assert.equal(runtime.getSkill("shared")?.prompt.trim(), "project-agents");
    assert.equal(runtime.getSkill("ignored"), undefined);
  });

  it("prefers the nearest project skill and stops at the git root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-team-skill-parent-"));
    const root = join(parent, "repo");
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeSkill(join(parent, ".agents", "skills", "outside"), "outside", "outside");
    await writeSkill(join(root, ".agents", "skills", "shared"), "shared", "root");
    await writeSkill(join(nested, ".agents", "skills", "shared"), "shared", "nested");

    const runtime = await SkillRuntime.discover({ cwd: nested, userSkillRoot: join(parent, "user-skills") });

    assert.equal(runtime.getSkill("shared")?.prompt.trim(), "nested");
    assert.equal(runtime.getSkill("outside"), undefined);
  });

  it("parses tui-code style skill metadata while preserving unknown frontmatter", () => {
    const skill = parseSkillMarkdown(`---
name: reviewer
description: Review helper
when_to_use: Use for code review
allowed-tools:
  - Read
  - Grep
model: fast
effort: high
mode: fork
custom_field: keep-me
---
Review carefully.
`);

    assert.equal(skill.name, "reviewer");
    assert.equal(skill.whenToUse, "Use for code review");
    assert.deepEqual(skill.allowedTools, ["Read", "Grep"]);
    assert.equal(skill.model, "fast");
    assert.equal(skill.effort, "high");
    assert.equal(skill.mode, "fork");
    assert.equal(skill.metadata?.custom_field, "keep-me");
  });

  it("activates inline skills as system context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-inline-skill-"));
    await mkdir(join(cwd, ".git"));
    await writeSkill(join(cwd, ".agents", "skills", "planner"), "planner", "Always plan first.");
    const runtime = await SkillRuntime.discover({ cwd });

    const result = await runtime.activateSkill("planner", {
      mode: "inline",
      messages: [{ role: "user", content: "Build it" }]
    });

    assert.equal(result.mode, "inline");
    assert.match(result.messages.at(-1)?.content as string, /SKILL planner/);
    assert.match(result.messages.at(-1)?.content as string, /Always plan first/);
  });

  it("runs fork skills through a constrained child model request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-fork-skill-"));
    await mkdir(join(cwd, ".git"));
    await writeSkill(join(cwd, ".agents", "skills", "reviewer"), "reviewer", "Review only.", {
      mode: "fork",
      allowedTools: ["Read"]
    });
    const runtime = await SkillRuntime.discover({ cwd });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        return { content: "review result" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(tool("Read"));
    tools.add(tool("Write"));

    const result = await runtime.activateSkill("reviewer", {
      mode: "fork",
      prompt: "Review this file",
      provider,
      model: "fast",
      tools,
      parentPermissionMode: "default"
    });

    assert.equal(result.mode, "fork");
    assert.equal(result.output, "review result");
    assert.deepEqual(requests[0]?.tools.map((item) => item.name), ["Read"]);
    assert.equal(result.permissionMode, "default");
  });

  it("reports skill diagnostics for later TUI surfaces", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-skill-diagnostics-"));
    await mkdir(join(cwd, ".git"));
    await writeSkill(join(cwd, ".agents", "skills", "planner"), "planner", "Plan.", {
      mode: "inline",
      allowedTools: ["Read"]
    });
    const runtime = await SkillRuntime.discover({ cwd });

    assert.deepEqual(runtime.getDiagnostics(), [{
      name: "planner",
      source: "project",
      mode: "inline",
      path: join(cwd, ".agents", "skills", "planner", "SKILL.md"),
      description: undefined,
      whenToUse: undefined,
      allowedTools: ["Read"],
      argumentHint: undefined,
      version: undefined,
      userInvocable: true,
      disableModelInvocation: false,
      paths: undefined
    }]);
  });
});

async function writeSkill(
  dir: string,
  name: string,
  body: string,
  options: { mode?: string; allowedTools?: string[] } = {}
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const allowedTools = options.allowedTools?.length
    ? `allowed-tools:\n${options.allowedTools.map((item) => `  - ${item}`).join("\n")}\n`
    : "";
  await writeFile(join(dir, "SKILL.md"), `---
name: ${name}
${options.mode ? `mode: ${options.mode}\n` : ""}${allowedTools}---
${body}
`, "utf8");
}

function tool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: { type: "object" },
    async execute() {
      return { output: name };
    }
  };
}

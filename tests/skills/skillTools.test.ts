import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HookRuntime } from "../../src/hooks/runtime.js";
import { SkillRuntime } from "../../src/skills/runtime.js";
import { createListSkillsTool, createUseSkillTool } from "../../src/skills/skillTools.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

describe("skill tools", () => {
  it("lists available skills for model discovery", async () => {
    const runtime = new SkillRuntime([skill("planner", "Plan before coding.")]);
    const tool = createListSkillsTool(runtime);

    const result = await tool.execute({}, { cwd: process.cwd() });

    assert.match(result.output ?? "", /planner project inline/);
    assert.deepEqual((result.data as Array<{ name: string }>)[0]?.name, "planner");
  });

  it("activates inline skills and registers skill hooks", async () => {
    const hookRuntime = new HookRuntime();
    const runtime = new SkillRuntime([{
      ...skill("reviewer", "Review for production risk."),
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "verify-review" }] }]
      }
    }]);
    const tool = createUseSkillTool(runtime, { hookRuntime });

    const result = await tool.execute({ name: "reviewer" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /Activated skill reviewer/);
    assert.match(JSON.stringify(result.data), /SKILL reviewer/);
    assert.equal(hookRuntime.getDiagnostics().some((hook) => hook.source === "skill" && hook.command === "verify-review"), true);
  });

  it("does not duplicate skill hooks when the same skill is activated twice in one session", async () => {
    const hookRuntime = new HookRuntime();
    const runtime = new SkillRuntime([{
      ...skill("reviewer", "Review for production risk."),
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "verify-review" }] }]
      }
    }]);
    const tool = createUseSkillTool(runtime, { hookRuntime });

    await tool.execute({ name: "reviewer" }, { cwd: process.cwd(), sessionId: "session-1" });
    await tool.execute({ name: "reviewer" }, { cwd: process.cwd(), sessionId: "session-1" });

    assert.equal(hookRuntime.getDiagnostics().filter((hook) => hook.source === "skill" && hook.command === "verify-review").length, 1);
  });

  it("does not duplicate skill hooks across recreated UseSkill tool instances", async () => {
    const hookRuntime = new HookRuntime();
    const runtime = new SkillRuntime([{
      ...skill("reviewer", "Review for production risk."),
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "verify-review" }] }]
      }
    }]);

    await createUseSkillTool(runtime, { hookRuntime }).execute({ name: "reviewer" }, { cwd: process.cwd(), sessionId: "session-1" });
    await createUseSkillTool(runtime, { hookRuntime }).execute({ name: "reviewer" }, { cwd: process.cwd(), sessionId: "session-1" });

    assert.equal(hookRuntime.getDiagnostics().filter((hook) => hook.source === "skill" && hook.command === "verify-review").length, 1);
  });

  it("registers skill tools when a skill runtime is supplied", () => {
    const registry = createLocalToolRegistry({ skillRuntime: new SkillRuntime([skill("planner", "Plan.")]) });

    assert.equal(registry.get("ListSkills").name, "ListSkills");
    assert.equal(registry.get("UseSkill").name, "UseSkill");
  });

  it("describes available skills in the UseSkill routing prompt", () => {
    const runtime = new SkillRuntime([{
      ...skill("planner", "Plan."),
      description: "Planning helper",
      whenToUse: "Use before implementation"
    }]);
    const prompt = createUseSkillTool(runtime).prompt;
    const text = typeof prompt === "function" ? prompt() : prompt;

    assert.match(text ?? "", /Available skills/);
    assert.match(text ?? "", /planner/);
    assert.match(text ?? "", /Use before implementation/);
  });
});

function skill(name: string, prompt: string) {
  return {
    name,
    description: `${name} skill`,
    prompt,
    path: `skills/${name}/SKILL.md`,
    root: `skills/${name}`,
    source: "project" as const,
    mode: "inline" as const,
    metadata: {}
  };
}

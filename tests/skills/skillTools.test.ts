import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SkillRuntime } from "../../src/skills/runtime.js";
import { createListSkillsTool, createUseSkillTool } from "../../src/skills/skillTools.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

describe("skill tools", () => {
  it("lists available skills for model discovery", async () => {
    const runtime = new SkillRuntime([skill("planner", "Plan before coding.")]);
    const result = await createListSkillsTool(runtime).execute({}, { cwd: process.cwd() });

    assert.match(result.output ?? "", /planner project inline/);
    assert.deepEqual((result.data as Array<{ name: string }>)[0]?.name, "planner");
  });

  it("activates inline skills with arguments", async () => {
    const runtime = new SkillRuntime([skill("reviewer", "Review $ARGUMENTS for production risk.")]);
    const registry = createLocalToolRegistry({ skillRuntime: runtime });
    const result = await createUseSkillTool(runtime).execute(
      { name: "reviewer", args: "the patch" },
      { cwd: process.cwd(), sessionId: "session-1", toolRegistry: registry }
    );

    assert.match(result.output ?? "", /Activated skill reviewer/);
    assert.match(JSON.stringify(result.data), /Review the patch for production risk/);
    assert.deepEqual(runtime.getActivatedSkillNames("session-1"), ["reviewer"]);
  });

  it("skips duplicate inline activation in the same scope", async () => {
    const runtime = new SkillRuntime([skill("reviewer", "Review $ARGUMENTS for production risk.")]);
    const tool = createUseSkillTool(runtime);
    const context = { cwd: process.cwd(), sessionId: "session-1" };

    const first = await tool.execute({ name: "reviewer", args: "the patch" }, context);
    const second = await tool.execute({ name: "reviewer", args: "another patch" }, context);

    assert.match(first.output ?? "", /Activated skill reviewer/);
    assert.match(second.output ?? "", /already active/);
    assert.equal(second.data, undefined);
    assert.deepEqual(runtime.getActivatedSkillNames("session-1"), ["reviewer"]);
  });

  it("honors restored inline activation scopes", async () => {
    const runtime = new SkillRuntime([skill("reviewer", "Review carefully.")]);
    runtime.restoreActivationScope("restored-scope", ["reviewer"]);
    const tool = createUseSkillTool(runtime);

    const restored = await tool.execute({ name: "reviewer" }, { cwd: process.cwd(), skillActivationScopeId: "restored-scope" });
    const fresh = await tool.execute({ name: "reviewer" }, { cwd: process.cwd(), skillActivationScopeId: "fresh-scope" });

    assert.match(restored.output ?? "", /already active/);
    assert.match(fresh.output ?? "", /Activated skill reviewer/);
  });

  it("keeps fork skill execution repeatable", async () => {
    const runtime = new SkillRuntime([{ ...skill("reviewer", "Review $ARGUMENTS."), mode: "fork" as const }]);
    const tool = createUseSkillTool(runtime);
    let calls = 0;
    const provider = {
      async generate() {
        calls += 1;
        return { content: `review-${calls}` };
      }
    };
    const context = { cwd: process.cwd(), sessionId: "session-1", provider, model: "test-model" };

    await tool.execute({ name: "reviewer", args: "first" }, context);
    await tool.execute({ name: "reviewer", args: "second" }, context);

    assert.equal(calls, 2);
    assert.deepEqual(runtime.getActivatedSkillNames("session-1"), []);
  });

  it("registers skill tools when a skill runtime is supplied", () => {
    const registry = createLocalToolRegistry({ skillRuntime: new SkillRuntime([skill("planner", "Plan.")]) });

    assert.equal(registry.get("ListSkills").name, "ListSkills");
    assert.equal(registry.get("UseSkill").name, "UseSkill");
  });

  it("describes available skills in the UseSkill routing prompt", () => {
    const runtime = new SkillRuntime([{ ...skill("planner", "Plan."), description: "Planning helper", whenToUse: "Use before implementation" }]);
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
    userInvocable: true,
    disableModelInvocation: false,
    metadata: {}
  };
}
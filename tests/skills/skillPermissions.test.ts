import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { SkillRuntime } from "../../src/skills/runtime.js";
import { createUseSkillTool, skillPermissionRulesFromToolResult } from "../../src/skills/skillTools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";

describe("skill permission alignment", () => {
  it("auto-allows safe skills and asks for skills that grant tools", async () => {
    const safeRuntime = new SkillRuntime([skill("safe")]);
    const riskyRuntime = new SkillRuntime([skill("risky", ["Bash(npm test*)"])]);
    const safe = await checkToolPermission(createUseSkillTool(safeRuntime), { name: "safe" }, permissions());
    const risky = await checkToolPermission(createUseSkillTool(riskyRuntime), { name: "risky" }, { ...permissions(), allow: ["UseSkill"] });

    assert.equal(safe.decision, "allow");
    assert.equal(risky.decision, "ask");
    assert.match(risky.reason ?? "", /Safety confirmation/);
  });

  it("keeps deny and explicit ask above skill grants", async () => {
    const runtime = new SkillRuntime([skill("risky", ["Bash(npm test*)"])]);
    const tool = createUseSkillTool(runtime);
    const denied = await checkToolPermission(tool, { name: "risky" }, { ...permissions(), deny: ["UseSkill(risky)"] });
    const asked = await checkToolPermission(tool, { name: "risky" }, { ...permissions(), ask: ["UseSkill(risky)"] });

    assert.equal(denied.decision, "deny");
    assert.equal(asked.decision, "ask");
    assert.equal(asked.rule, "UseSkill(risky)");
  });

  it("treats inline allowed-tools as transient allow rules", async () => {
    const commandTool = tool("Bash");
    const allowed = await checkToolPermission(commandTool, { command: "npm test -- --run" }, { ...permissions(), transientAllow: ["Bash(npm test*)"] });
    const explicitlyAsked = await checkToolPermission(commandTool, { command: "npm test -- --run" }, { ...permissions(), ask: ["Bash(npm test*)"], transientAllow: ["Bash(npm test*)"] });
    const explicitlyDenied = await checkToolPermission(commandTool, { command: "npm test -- --run" }, { ...permissions(), deny: ["Bash(npm test*)"], transientAllow: ["Bash(npm test*)"] });

    assert.equal(allowed.decision, "allow");
    assert.equal(explicitlyAsked.decision, "ask");
    assert.equal(explicitlyDenied.decision, "deny");
  });

  it("does not leak fork skill grants into the parent permission context", async () => {
    const runtime = new SkillRuntime([{ ...skill("forked", ["Write"]), mode: "fork" as const }]);
    const registry = new ToolRegistry(runtime);
    const result = await createUseSkillTool(runtime).execute(
      { name: "forked", mode: "fork" },
      {
        cwd: process.cwd(),
        sessionId: "s1",
        model: "test",
        provider: { async generate() { return { content: "done" }; } },
        toolRegistry: registry,
        permissionMode: "default"
      }
    );

    assert.deepEqual(skillPermissionRulesFromToolResult(result), []);
    assert.deepEqual((result.data as { allowedTools: string[] }).allowedTools, ["Write"]);
  });
});

function permissions() {
  return { mode: "default" as const, cwd: process.cwd(), allow: [], ask: [], deny: [] };
}

function skill(name: string, allowedTools: string[] = []) {
  return {
    name,
    description: name,
    prompt: "Do the work.",
    path: `skills/${name}/SKILL.md`,
    root: `skills/${name}`,
    source: "project" as const,
    mode: "inline" as const,
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools,
    metadata: {}
  };
}

function tool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: { type: "object" },
    async execute() {
      return { output: "ok" };
    }
  };
}

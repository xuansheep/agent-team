import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalSkills, loadSkillFile, parseSkillMarkdown } from "../../src/skills/skillLoader.js";

describe("skill loader", () => {
  it("loads a local SKILL.md as prompt-only skill context", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-skills-"));
    const skillDir = join(root, "planner");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), `---
name: planner
description: Planning helper
---
Always plan before executing.
`, "utf8");

    const skills = await loadLocalSkills(root);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "planner");
    assert.equal(skills[0]?.description, "Planning helper");
    assert.equal(skills[0]?.prompt.trim(), "Always plan before executing.");
    assert.equal(skills[0]?.source, "local");
  });

  it("loads a single skill file", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-skill-file-"));
    const path = join(root, "SKILL.md");
    await writeFile(path, `---
name: reviewer
---
Review risks.
`, "utf8");

    const skill = await loadSkillFile(path);

    assert.equal(skill.name, "reviewer");
    assert.equal(skill.prompt.trim(), "Review risks.");
  });

  it("parses markdown without marketplace or executable plugin behavior", () => {
    const skill = parseSkillMarkdown("Plain prompt body.", "plain.md");

    assert.deepEqual(skill, {
      name: "plain",
      userInvocable: true,
      disableModelInvocation: false,
      prompt: "Plain prompt body.",
      metadata: {}
    });
  });
});

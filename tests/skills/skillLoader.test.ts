import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillFile, parseSkillMarkdown } from "../../src/skills/skillLoader.js";

describe("skill loader", () => {

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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentsMemoryFiles, getAgentsPrompt } from "../../src/context/agentsMemory.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-agents-memory-"));
}

describe("agentsMemory", () => {
  it("loads user, project, nested project, local, rules, and configured prompts in priority order", async () => {
    const cwd = await workspace();
    const home = await workspace();
    const nested = join(cwd, "packages", "app");
    await mkdir(join(home, ".einsteins"), { recursive: true });
    await mkdir(join(cwd, ".einsteins", "rules"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(home, ".einsteins", "AGENTS.md"), "User instructions.\n", "utf8");
    await writeFile(join(cwd, "AGENTS.md"), "Root project instructions.\n", "utf8");
    await writeFile(join(nested, "AGENTS.md"), "Nested project instructions.\n", "utf8");
    await writeFile(join(nested, "AGENTS.local.md"), "Local instructions.\n", "utf8");
    await writeFile(join(cwd, ".einsteins", "rules", "style.md"), "Rule instructions.\n", "utf8");
    await writeFile(join(cwd, "GLOBAL.md"), "Configured instructions.\n", "utf8");

    const files = await getAgentsMemoryFiles({ cwd: nested, homeDir: home, configDir: cwd, configuredPromptFile: "GLOBAL.md" });

    assert.deepEqual(files.map((file) => file.content.trim()), [
      "User instructions.",
      "Root project instructions.",
      "Rule instructions.",
      "Nested project instructions.",
      "Local instructions.",
      "Configured instructions."
    ]);
    assert.match(getAgentsPrompt(files) ?? "", /Codebase and user instructions are shown below/);
  });

  it("loads includes before including files and skips cycles", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "extra.md"), "Included instructions.\n", "utf8");
    await writeFile(join(cwd, "AGENTS.md"), "Before @./extra.md\nAfter.\n", "utf8");

    const files = await getAgentsMemoryFiles({ cwd });

    assert.deepEqual(files.map((file) => file.content.trim()), [
      "Included instructions.",
      "Before @./extra.md\nAfter."
    ]);
  });

  it("blocks external includes unless approved", async () => {
    const cwd = await workspace();
    const external = await workspace();
    await writeFile(join(external, "outside.md"), "External instructions.\n", "utf8");
    const externalInclude = join(external, "outside.md").replaceAll("\\", "/");
    await writeFile(join(cwd, "AGENTS.md"), `@${externalInclude}\nProject instructions.\n`, "utf8");

    const blocked = await getAgentsMemoryFiles({ cwd });
    const approved = await getAgentsMemoryFiles({ cwd, settings: { hasAgentsMdExternalIncludesApproved: true } });

    assert.deepEqual(blocked.map((file) => file.content.trim()), [`@${externalInclude}\nProject instructions.`]);
    assert.deepEqual(approved.map((file) => file.content.trim()), ["External instructions.", `@${externalInclude}\nProject instructions.`]);
  });
});

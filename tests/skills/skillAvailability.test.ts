import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadDisabledSkillNames, setSkillDisabledState, watchDisabledSkillNames } from "../../src/skills/availability.js";

describe("skill availability settings", () => {
  it("persists disabled skills independently for each project", async () => {
    const root = await temporaryRoot();
    const settingsPath = join(root, "settings.json");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");

    await setSkillDisabledState({ cwd: projectA, userSettingsPath: settingsPath }, "reviewer", true);
    await setSkillDisabledState({ cwd: projectA, userSettingsPath: settingsPath }, "planner", true);
    await setSkillDisabledState({ cwd: projectA, userSettingsPath: settingsPath }, "reviewer", false);

    assert.deepEqual(await loadDisabledSkillNames({ cwd: projectA, userSettingsPath: settingsPath }), ["planner"]);
    assert.deepEqual(await loadDisabledSkillNames({ cwd: projectB, userSettingsPath: settingsPath }), []);
  });

  it("hot reloads atomic updates and retains the last valid state across malformed settings", async () => {
    const root = await temporaryRoot();
    const settingsPath = join(root, "settings.json");
    const options = { cwd: join(root, "project"), userSettingsPath: settingsPath };
    await setSkillDisabledState(options, "initial", true);
    const changes: string[][] = [];
    const errors: Error[] = [];
    const stop = watchDisabledSkillNames(options, {
      onChange: (names) => changes.push(names),
      onError: (error) => errors.push(error)
    }, 10);

    try {
      await setSkillDisabledState(options, "external", true);
      await waitFor(() => changes.some((names) => names.join(",") === "external,initial"));
      const lastValid = changes.at(-1);

      await writeFile(settingsPath, "{ invalid", "utf8");
      await waitFor(() => errors.length > 0);
      assert.deepEqual(changes.at(-1), lastValid);

      await writeFile(settingsPath, JSON.stringify({ projects: { [resolve(options.cwd)]: { disabledSkills: ["recovered"] } } }), "utf8");
      await waitFor(() => changes.at(-1)?.join(",") === "recovered");
    } finally {
      stop();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const parent = resolve(".tmp");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "skill-availability-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for skill settings update");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

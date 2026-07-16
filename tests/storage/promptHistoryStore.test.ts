import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPromptHistoryStore,
  defaultUserHistoryPath,
  type PromptHistoryRecord
} from "../../src/storage/promptHistoryStore.js";

describe("PromptHistoryStore", () => {
  it("uses ~/.einsteins/history.jsonl by default", () => {
    assert.equal(defaultUserHistoryPath("home-root"), join("home-root", ".einsteins", "history.jsonl"));
  });

  it("loads history across sessions for the same Git project", async () => {
    const fixture = await createFixture("cross-session");
    const first = await createPromptHistoryStore({
      cwd: fixture.cwd,
      path: fixture.historyPath,
      sessionId: "session-one"
    });

    first.add("first prompt");
    first.add("second prompt");
    await first.flush();

    const second = await createPromptHistoryStore({
      cwd: fixture.cwd,
      path: fixture.historyPath,
      sessionId: "session-two"
    });

    assert.deepEqual(second.entries, ["first prompt", "second prompt"]);
    assert.equal(second.project, normalize(resolve(fixture.projectRoot)));
  });

  it("isolates history by Git project", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-history-projects-"));
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    const historyPath = join(root, "home", ".einsteins", "history.jsonl");
    await mkdir(join(firstProject, ".git"), { recursive: true });
    await mkdir(join(secondProject, ".git"), { recursive: true });

    const first = await createPromptHistoryStore({ cwd: firstProject, path: historyPath, sessionId: "first-session" });
    first.add("only in first");
    await first.flush();

    const second = await createPromptHistoryStore({ cwd: secondProject, path: historyPath, sessionId: "second-session" });
    assert.deepEqual(second.entries, []);
  });

  it("skips malformed records and keeps the newest 100 entries including duplicates", async () => {
    const fixture = await createFixture("limits");
    const store = await createPromptHistoryStore({
      cwd: fixture.cwd,
      path: fixture.historyPath,
      sessionId: "writer"
    });

    for (let index = 0; index < 101; index += 1) store.add(`prompt-${index}`);
    store.add("prompt-100");
    await store.flush();
    await appendFile(fixture.historyPath, "{broken json}\n", "utf8");

    const reloaded = await createPromptHistoryStore({
      cwd: fixture.cwd,
      path: fixture.historyPath,
      sessionId: "reader"
    });

    assert.equal(reloaded.entries.length, 100);
    assert.equal(reloaded.entries.at(-1), "prompt-100");
    assert.equal(reloaded.entries.at(-2), "prompt-100");
    assert.equal(reloaded.entries[0], "prompt-2");
  });

  it("serializes concurrent writers without corrupting JSONL records", async () => {
    const fixture = await createFixture("concurrent");
    const left = await createPromptHistoryStore({ cwd: fixture.cwd, path: fixture.historyPath, sessionId: "left" });
    const right = await createPromptHistoryStore({ cwd: fixture.cwd, path: fixture.historyPath, sessionId: "right" });

    for (let index = 0; index < 5; index += 1) {
      left.add(`left-${index}`);
      right.add(`right-${index}`);
    }
    await Promise.all([left.flush(), right.flush()]);

    const lines = (await readFile(fixture.historyPath, "utf8")).trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as PromptHistoryRecord);
    assert.equal(records.length, 10);
    assert.deepEqual(
      new Set(records.map((record) => record.display)),
      new Set(["left-0", "left-1", "left-2", "left-3", "left-4", "right-0", "right-1", "right-2", "right-3", "right-4"])
    );
  });
});

async function createFixture(name: string): Promise<{ projectRoot: string; cwd: string; historyPath: string }> {
  const root = await mkdtemp(join(tmpdir(), `agent-team-history-${name}-`));
  const projectRoot = join(root, "project");
  const cwd = join(projectRoot, "nested");
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    projectRoot,
    cwd,
    historyPath: join(root, "home", ".einsteins", "history.jsonl")
  };
}

function normalize(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

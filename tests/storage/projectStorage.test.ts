import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareProjectStorage, sanitizeProjectPath, sessionDirectory } from "../../src/storage/projectStorage.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import { RunStore } from "../../src/storage/runStore.js";

describe("project session storage", () => {
  it("uses the tui-code project key rule and stores sessions directly by sessionId", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-project-home-"));
    const cwd = "D:\\work\\code-ai\\agent-team";
    const storage = await prepareProjectStorage({ cwd, homeDir });

    assert.equal(sanitizeProjectPath(cwd), "D--work-code-ai-agent-team");
    assert.equal(storage.projectDir, join(homeDir, ".einsteins", "projects", "D--work-code-ai-agent-team"));
    assert.equal(sessionDirectory(storage, "session-123"), join(storage.projectDir, "session-123"));
    assert.doesNotMatch(sessionDirectory(storage, "session-123"), /\d{6}[\\/]|\d{2}T\d{6}-/);
  });

  it("fails closed when two project paths map to the same tui-code directory name", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-project-collision-"));
    const first = join(homeDir, "a+b");
    const second = join(homeDir, "a-b");

    await prepareProjectStorage({ cwd: first, homeDir });
    await assert.rejects(
      () => prepareProjectStorage({ cwd: second, homeDir }),
      /Project storage key collision/
    );
  });

  it("keeps session metadata separate from run metadata", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-project-separation-"));
    const cwd = join(homeDir, "workspace");
    const storage = await prepareProjectStorage({ cwd, homeDir });
    const sessions = new SessionStore(storage);
    const runs = new RunStore(storage);

    await sessions.saveMetadata("session-1", { inputPreview: "build it" });
    const run = await runs.createRun("delivery", { request: "build it" }, { sessionId: "session-1" });
    await sessions.attachRun("session-1", run.runId);

    const session = JSON.parse(await readFile(join(storage.projectDir, "session-1", "session.json"), "utf8")) as Record<string, unknown>;
    const runMetadata = JSON.parse(await readFile(join(run.runDir, "run.json"), "utf8")) as Record<string, unknown>;

    assert.deepEqual(session.runIds, [run.runId]);
    assert.equal(session.currentRunId, run.runId);
    assert.equal("workflowId" in session, false);
    assert.equal("status" in session, false);
    assert.equal(runMetadata.sessionId, "session-1");
    assert.equal(runMetadata.workflowId, "delivery");
    assert.equal("plan" in runMetadata, false);
    assert.equal("status" in runMetadata, false);
  });

  it("serializes concurrent session updates across store instances", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "agent-team-project-concurrency-"));
    const storage = await prepareProjectStorage({ cwd: join(homeDir, "workspace"), homeDir });
    const first = new SessionStore(storage);
    const second = new SessionStore(storage);

    await Promise.all([
      first.saveMetadata("session-race", { inputPreview: "hello" }),
      second.saveMetadata("session-race", {
        promptInjection: {
          globalPrompt: {
            type: "global_prompt",
            recordedAt: "2026-07-16T00:00:00.000Z",
            available: true,
            presentInRequest: true,
            injectedThisTurn: true,
            sha256: "hash",
            chars: 1,
            lines: 1,
            sources: []
          }
        }
      })
    ]);

    const metadata = await first.loadMetadata("session-race");
    assert.equal(metadata?.inputPreview, "hello");
    assert.equal(metadata?.promptInjection?.globalPrompt?.sha256, "hash");
    assert.deepEqual(JSON.parse(await readFile(join(storage.projectDir, "session-race", "session.json"), "utf8")), metadata);
  });
});

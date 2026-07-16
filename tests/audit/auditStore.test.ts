import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../../src/audit/auditStore.js";
import { RunStore } from "../../src/storage/runStore.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-audit-store-"));
}

describe("AuditStore", () => {
  it("appends a durable SHA-256 hash chain", async () => {
    const sessionDir = await workspace();
    const store = new AuditStore(sessionDir);

    assert.equal(store.path, join(sessionDir, "audit.ndjson"));
    assert.deepEqual(await store.readEvents(), []);

    await store.append({ type: "permission_decision", session_id: "session-1", tool: "Write", decision: "deny", reason: "blocked" });
    await store.append({ type: "tool_result", session_id: "session-1", tool: "Write", status: "failed", error: "blocked" });

    const events = await store.readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "permission_decision");
    assert.equal(events[0].session_id, "session-1");
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].seq, 2);
    assert.equal(events[1].prev_hash, events[0].hash);
    assert.match(events[0].hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await store.verify(), { valid: true, count: 2, lastHash: events[1].hash });

    const raw = await readFile(store.path, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  });

  it("mirrors durable run tool events into the session audit chain", async () => {
    const projectDir = await workspace();
    const runStore = new RunStore(projectDir);
    const run = await runStore.createRun("delivery", { request: "write" }, { sessionId: "session-audit" });

    await runStore.appendEvent(run.runId, { type: "tool_invoked", node_id: "worker", attempt: 1, tool: "Write", input: { file_path: "a.txt", content: "hello" } });
    await runStore.appendEvent(run.runId, { type: "tool_completed", node_id: "worker", attempt: 1, tool: "Write", result: { output: "ok" } });

    const audit = new AuditStore(join(projectDir, "session-audit"));
    const records = await audit.readEvents();
    assert.deepEqual(records.map((record) => record.type), ["tool_invocation", "file_write", "tool_result"]);
    assert.equal((records[1] as { path?: string }).path, "a.txt");
    assert.equal((await audit.verify()).valid, true);
  });

  it("detects modified audit content and refuses to append", async () => {
    const sessionDir = await workspace();
    const store = new AuditStore(sessionDir);
    await store.append({ type: "tool_invocation", session_id: "session-1", tool: "Write", input: { path: "a.txt" } });

    const raw = await readFile(store.path, "utf8");
    await writeFile(store.path, raw.replace('"a.txt"', '"b.txt"'), "utf8");

    const verification = await store.verify();
    assert.equal(verification.valid, false);
    assert.match(verification.error ?? "", /hash mismatch/);
    await assert.rejects(
      () => store.append({ type: "tool_result", session_id: "session-1", tool: "Write", status: "completed" }),
      /verification failed/
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditStore } from "../../src/audit/auditStore.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-audit-store-"));
}

describe("AuditStore", () => {
  it("appends and reads local NDJSON audit events", async () => {
    const cwd = await workspace();
    const store = new AuditStore(join(cwd, ".session"));

    assert.match(store.path, /[.]session[\\/]audit[.]ndjson$/);
    assert.deepEqual(await store.readEvents(), []);

    await store.append({ type: "permission_decision", session_id: "session-1", tool: "Write", decision: "deny", reason: "blocked" });
    await store.append({ type: "tool_result", session_id: "session-1", tool: "Write", status: "failed", error: "blocked" });

    const events = await store.readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "permission_decision");
    assert.equal(events[0].session_id, "session-1");
    assert.equal(typeof events[0].timestamp, "string");

    const raw = await readFile(store.path, "utf8");
    assert.equal(raw.trim().split("\n").length, 2);
  });
});

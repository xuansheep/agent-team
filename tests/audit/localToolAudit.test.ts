import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditEvent } from "../../src/audit/auditEvent.js";
import { writePlan } from "../../src/plans/planFiles.js";
import { PlanSessionState } from "../../src/plans/planSession.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-local-audit-"));
}

describe("local tool audit", () => {
  it("audits file writes and shell commands", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const auditEvents: AuditEvent[] = [];
    const context = { cwd, sessionId: "session-local", runId: "run-local", auditSink: (event: AuditEvent) => { auditEvents.push(event); } };

    await tools.get("Write").execute({ file_path: "a.txt", content: "hello" }, context);
    const shellResult = await tools.get("Bash").execute({ command: "node -v", timeout_ms: 30000 }, context);

    assert.equal(typeof shellResult.exit_code, "number");
    const fileWrite = auditEvents.find((event) => event.type === "file_write");
    assert.equal(fileWrite?.tool, "Write");
    assert.match(fileWrite?.path ?? "", /a[.]txt$/);

    const shell = auditEvents.find((event) => event.type === "shell_command");
    assert.equal(shell?.tool, "Bash");
    assert.equal(shell?.destructive, false);
  });

  it("audits Plan Mode enter and approval request tools", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const auditEvents: AuditEvent[] = [];
    const context = { cwd, sessionId: "session-plan", auditSink: (event: AuditEvent) => { auditEvents.push(event); } };

    const entered = await tools.get("EnterPlanMode").execute({
      sessionId: "session-plan",
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    }, context);
    const state = (entered.data as { state: PlanSessionState }).state;
    await writePlan(state.planFilePath, "# Plan\nDo it.\n");
    await tools.get("ExitPlanMode").execute({ state }, context);

    assert.deepEqual(
      auditEvents.filter((event) => event.type === "plan_mode").map((event) => event.action),
      ["entered", "approval_requested"]
    );
  });
});

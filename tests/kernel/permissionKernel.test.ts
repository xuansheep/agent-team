import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";
import { PermissionKernel } from "../../src/kernel/permissions/permissionKernel.js";
import { enterPlanMode } from "../../src/plans/planSession.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-permission-kernel-"));
}

describe("PermissionKernel", () => {
  it("allows only current plan file writes in plan mode through kernel policy", async () => {
    const cwd = await workspace();
    const tools = createKernelToolRegistry(createLocalToolRegistry());
    const entered = enterPlanMode({ sessionId: "s1", cwd, originalInput: { request: "build" }, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const kernel = new PermissionKernel();

    const planWrite = await kernel.check(tools.get("Write"), { file_path: entered.state.planFilePath, content: "# Plan" }, { ...entered.permissions, cwd });
    const planEdit = await kernel.check(tools.get("Edit"), { file_path: entered.state.planFilePath, old_string: "# Plan", new_string: "# Plan\n" }, { ...entered.permissions, cwd });
    const codeWrite = await kernel.check(tools.get("Write"), { file_path: "src/index.ts", content: "x" }, { ...entered.permissions, cwd });
    const shell = await kernel.check(tools.get("PowerShell"), { command: "Get-ChildItem" }, { ...entered.permissions, cwd });

    assert.equal(planWrite.decision, "allow");
    assert.equal(planWrite.reason, "Plan Mode plan file write");
    assert.equal(planEdit.decision, "allow");
    assert.equal(codeWrite.decision, "deny");
    assert.match(codeWrite.reason ?? "", /Plan Mode writes are limited to the current plan file/);
    assert.match(codeWrite.reason ?? "", new RegExp(entered.state.planFilePath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.equal(shell.decision, "deny");
    assert.equal(shell.reason, "Plan Mode blocks shell execution");
  });
});

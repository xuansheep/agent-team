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
  it("allows only current plan file writes in plan mode", async () => {
    const cwd = await workspace();
    const tools = createKernelToolRegistry(createLocalToolRegistry());
    const entered = enterPlanMode({
      sessionId: "s1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    const kernel = new PermissionKernel();

    assert.equal((await kernel.check(tools.get("Write"), { file_path: entered.state.planFilePath, content: "# Plan" }, { ...entered.permissions, cwd })).decision, "allow");
    assert.equal((await kernel.check(tools.get("Write"), { file_path: "src/index.ts", content: "x" }, { ...entered.permissions, cwd })).decision, "deny");
    assert.equal((await kernel.check(tools.get("PowerShell"), { command: "Get-ChildItem" }, { ...entered.permissions, cwd })).decision, "deny");
  });
});

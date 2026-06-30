import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { createKernelSession } from "../../src/kernel/session.js";
import { buildPlanModeAttachment } from "../../src/kernel/plan/attachments.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";
import { PlanModeController } from "../../src/kernel/plan/planModeController.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-tool-protocol-"));
}

describe("Kernel tool protocol", () => {
  it("builds plan mode instructions from kernel state", async () => {
    const cwd = await workspace();
    const controller = new PlanModeController();
    const session = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });

    const attachment = buildPlanModeAttachment(session);

    assert.match(attachment.content, /Plan Mode is active/);
    assert.match(attachment.content, /ExitPlanMode/);
    assert.match(attachment.content, /AskUserQuestion/);
    assert.match(attachment.content, /Plan file:/);
    assert.equal(attachment.planFilePath, session.planState!.planFilePath);
  });

  it("exposes write tools in plan mode while keeping EnterPlanMode hidden", () => {
    const registry = createKernelToolRegistry(createLocalToolRegistry());
    const visible = registry.visibleTools({ mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" }).map((tool) => tool.name);

    assert.equal(visible.includes("Write"), true);
    assert.equal(visible.includes("Edit"), true);
    assert.equal(visible.includes("MultiEdit"), true);
    assert.equal(visible.includes("AskUserQuestion"), true);
    assert.equal(visible.includes("ExitPlanMode"), true);
    assert.equal(visible.includes("EnterPlanMode"), false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKernelSession } from "../../src/kernel/session.js";
import { PlanModeController } from "../../src/kernel/plan/planModeController.js";
import { QueryEngine } from "../../src/kernel/queryEngine.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { readPlan, writePlan } from "../../src/plans/planFiles.js";
import { writeTool } from "../../src/tools/local/write.js";

function providerWithToolCalls(tool_calls: { id: string; name: string; input: unknown }[]): ModelProvider {
  return { generate: async () => ({ content: "", tool_calls }), stream: undefined } as unknown as ModelProvider;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-query-engine-"));
}

describe("QueryEngine", () => {
  it("turns AskUserQuestion into pending interaction and preserves messages", async () => {
    const legacy = new ToolRegistry();
    legacy.add({
      name: "AskUserQuestion",
      description: "ask",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => ({ data: { type: "user_input_requested", questions: [{ question: "Pick?" }] } })
    });
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions: { mode: "plan", allow: [], ask: [], deny: [] }, messages: [{ role: "user", content: "plan this" }] });

    const result = await new QueryEngine().run({
      session,
      provider: providerWithToolCalls([{ id: "call-1", name: "AskUserQuestion", input: { questions: [{ question: "Pick?" }] } }]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(result.session.status, "waiting_user_input");
    assert.equal(result.session.pendingInteraction?.type, "ask_user_question");
    assert.equal(result.session.messages[0].content, "plan this");
  });

  it("turns ExitPlanMode into kernel-owned pending plan approval", async () => {
    const cwd = await workspace();
    let executions = 0;
    const legacy = new ToolRegistry();
    legacy.add({
      name: "ExitPlanMode",
      description: "exit",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => {
        executions += 1;
        return { output: "legacy should not own approval" };
      }
    });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);
    await writePlan(planning.planState.planFilePath, "# Plan\n\nApprove me.\n");

    const result = await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([{ id: "call-1", name: "ExitPlanMode", input: {} }]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(executions, 0);
    assert.equal(result.session.status, "waiting_plan_approval");
    assert.equal(result.session.pendingInteraction?.type, "plan_approval");
    assert.equal("document" in result.session.pendingInteraction, false);
    assert.equal(await readPlan(planning.planState.planFilePath), "# Plan\n\nApprove me.\n");
    assert.match(result.session.pendingInteraction?.planHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(result.session.planState?.mode, "waiting_approval");
  });

  it("executes current plan file writes before creating ExitPlanMode approval interaction", async () => {
    const cwd = await workspace();
    const legacy = new ToolRegistry();
    legacy.add(writeTool);
    legacy.add({
      name: "ExitPlanMode",
      description: "exit",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => ({ output: "legacy should not own approval" })
    });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);

    const result = await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([
        { id: "call-write-plan", name: "Write", input: { file_path: planning.planState.planFilePath, content: "# Plan\n\nKernel wrote this first.\n" } },
        { id: "call-exit-plan", name: "ExitPlanMode", input: {} }
      ]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(result.session.status, "waiting_plan_approval");
    assert.equal(result.session.pendingInteraction?.type, "plan_approval");
    assert.equal(result.session.pendingInteraction?.empty, undefined);
    assert.equal(await readPlan(planning.planState.planFilePath), "# Plan\n\nKernel wrote this first.\n");
  });

  it("turns ExitPlanMode into a plan approval interaction even when pre-plan mode was bypassPermissions", async () => {
    const cwd = await workspace();
    let executions = 0;
    const legacy = new ToolRegistry();
    legacy.add({
      name: "ExitPlanMode",
      description: "exit",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => {
        executions += 1;
        return { output: "legacy should not own approval" };
      }
    });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({
      id: "kernel-interaction-bypass",
      cwd,
      permissions: { mode: "bypassPermissions", allow: [], ask: [], deny: [] }
    }), { request: "build" });
    assert.ok(planning.planState);
    await writePlan(planning.planState.planFilePath, "# Plan\n\nApprove me.\n");

    const result = await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([{ id: "exit-plan", name: "ExitPlanMode", input: {} }]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(executions, 0);
    assert.equal(result.session.pendingInteraction?.type, "plan_approval");
    assert.equal(result.session.status, "waiting_plan_approval");
  });

  it("does not normalize Plan Mode write tool paths before permission checks", async () => {
    const cwd = await workspace();
    let calls = 0;
    const legacy = new ToolRegistry();
    legacy.add(writeTool);
    legacy.add({
      name: "ExitPlanMode",
      description: "exit",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => ({ output: "legacy should not own approval" })
    });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);
    const truncatedPlanFilePath = planning.planState.planFilePath.slice(0, Math.max(3, Math.floor(planning.planState.planFilePath.length / 3)));
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) return { content: "too early", tool_calls: [{ id: "call-empty-exit", name: "ExitPlanMode", input: {} }] };
        if (calls === 2) return { content: "write plan", tool_calls: [{ id: "call-write-plan", name: "Write", input: { file_path: truncatedPlanFilePath, content: "# Plan\n\nKernel should not normalize this path.\n" } }] };
        assert.equal(request.messages.at(-1)?.role, "tool");
        assert.match(String(request.messages.at(-1)?.content), /Plan Mode writes are limited to the current plan file/);
        return { content: "I need to write the exact plan file path." };
      }
    };

    const result = await new QueryEngine().run({
      session: planning,
      provider,
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(result.session.status, "idle_input");
    assert.equal(calls, 3);
    assert.equal(await readPlan(planning.planState.planFilePath), undefined);
    const writeCall = result.session.messages.flatMap((message) => message.role === "assistant" ? message.tool_calls ?? [] : []).find((call) => call.id === "call-write-plan");
    assert.equal((writeCall?.input as { file_path?: unknown } | undefined)?.file_path, truncatedPlanFilePath);
  });

  it("does not run custom Plan Mode plain-text repair reminders", async () => {
    const cwd = await workspace();
    let calls = 0;
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: "Plan Mode blocks editing source files, so I cannot continue." };
      }
    };

    const result = await new QueryEngine().run({
      session: planning,
      provider,
      model: "test-model",
      tools: createKernelToolRegistry(new ToolRegistry())
    });

    assert.equal(result.session.status, "idle_input");
    assert.equal(calls, 1);
    assert.equal(result.session.messages.filter((message) => String(message.content).includes("Plan Mode is still active")).length, 0);
  });

});

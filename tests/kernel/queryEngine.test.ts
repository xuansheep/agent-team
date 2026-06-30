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
    const legacy = new ToolRegistry();
    legacy.add({
      name: "ExitPlanMode",
      description: "exit",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => ({ output: "legacy should not own approval" })
    });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });

    const result = await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([{ id: "call-1", name: "ExitPlanMode", input: { plan: "# Plan" } }]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(result.session.status, "waiting_plan_approval");
    assert.equal(result.session.pendingInteraction?.type, "plan_approval");
    assert.match(result.session.pendingInteraction?.planHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(result.session.planState?.mode, "waiting_approval");
  });
});

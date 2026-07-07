import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
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

function assertToolCallsClosed(messages: { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      assert.ok(message.tool_call_id, "tool message must include tool_call_id");
      assert.equal(pending.delete(message.tool_call_id), true, `unexpected tool result ${message.tool_call_id}`);
      continue;
    }
    assert.equal(pending.size, 0, `missing tool result for ${[...pending].join(", ")}`);
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) pending.add(call.id);
    }
  }
  assert.equal(pending.size, 0, `missing tool result for ${[...pending].join(", ")}`);
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
    const initialPlanFilePath = planning.planState.planFilePath;
    const planText = "# Plan Dir Create\n\nKernel wrote this first.\n";

    const result = await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([
        { id: "call-write-plan", name: "Write", input: { file_path: initialPlanFilePath, content: planText } },
        { id: "call-exit-plan", name: "ExitPlanMode", input: {} }
      ]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    const finalPlanFilePath = result.session.planState?.planFilePath ?? "";
    assert.equal(result.session.status, "waiting_plan_approval");
    assert.equal(result.session.pendingInteraction?.type, "plan_approval");
    assert.equal(result.session.pendingInteraction?.planFilePath, finalPlanFilePath);
    assert.equal(result.session.pendingInteraction?.empty, undefined);
    assert.match(finalPlanFilePath, /[\\/]plans[\\/]plan-dir-create[.]md$/);
    assert.equal(await readPlan(finalPlanFilePath), planText);
    assert.equal(await readPlan(initialPlanFilePath), undefined);
    const writeCall = result.session.messages.flatMap((message) => message.role === "assistant" ? message.tool_calls ?? [] : []).find((call) => call.id === "call-write-plan");
    assert.equal((writeCall?.input as { file_path?: unknown } | undefined)?.file_path, finalPlanFilePath);
  });

  it("names the first plan file from the assistant response when the draft has no heading", async () => {
    const cwd = await workspace();
    const legacy = new ToolRegistry();
    legacy.add(writeTool);
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Plan Dir Create",
          tool_calls: [{ id: "call-write-plan", name: "Write", input: { file_path: planning.planState!.planFilePath, content: "No markdown heading here.\n" } }]
        };
      }
    };

    const result = await new QueryEngine().run({
      session: planning,
      provider,
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    const finalPlanFilePath = result.session.planState?.planFilePath ?? "";
    assert.match(finalPlanFilePath, /[\\/]plans[\\/]plan-dir-create[.]md$/);
    assert.equal(await readPlan(finalPlanFilePath), "No markdown heading here.\n");
  });

  it("adds a numeric suffix when a named plan already exists in the session", async () => {
    const cwd = await workspace();
    const legacy = new ToolRegistry();
    legacy.add(writeTool);
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);
    await writePlan(join(dirname(planning.planState.planFilePath), "plan-dir-create.md"), "# Existing\n");

    const result = await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([{ id: "call-write-plan", name: "Write", input: { file_path: planning.planState.planFilePath, content: "# Plan Dir Create\n\nNew plan.\n" } }]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    const finalPlanFilePath = result.session.planState?.planFilePath ?? "";
    assert.match(finalPlanFilePath, /[\\/]plans[\\/]plan-dir-create-2[.]md$/);
    assert.equal(await readPlan(finalPlanFilePath), "# Plan Dir Create\n\nNew plan.\n");
  });

  it("turns ExitPlanMode into a plan approval interaction even when pre-plan mode was fullAccess", async () => {
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
      id: "kernel-interaction-full-access",
      cwd,
      permissions: { mode: "fullAccess", allow: [], ask: [], deny: [] }
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

  it("closes rejected ExitPlanMode approval before the next provider request", async () => {
    const cwd = await workspace();
    const legacy = new ToolRegistry();
    legacy.add({
      name: "ExitPlanMode",
      description: "exit",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => ({ output: "legacy should not own approval" })
    });
    const tools = createKernelToolRegistry(legacy);
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);
    await writePlan(planning.planState.planFilePath, "# Plan\n\nApprove me.\n");
    const waiting = (await new QueryEngine().run({
      session: planning,
      provider: providerWithToolCalls([{ id: "exit-plan", name: "ExitPlanMode", input: {} }]),
      model: "test-model",
      tools
    })).session;
    const rejected = (await controller.resolvePlanApproval(waiting, { decision: "stay", feedback: "输出中文方案" })).session;
    const provider: ModelProvider = {
      async generate(request) {
        assertToolCallsClosed(request.messages);
        return { content: "继续规划。" };
      }
    };

    const result = await new QueryEngine().run({
      session: { ...rejected, messages: [...rejected.messages, { role: "user", content: "输出中文方案" }] },
      provider,
      model: "test-model",
      tools
    });

    assert.equal(result.session.status, "idle_input");
    assert.ok(result.session.messages.some((message) => message.role === "tool" && message.tool_call_id === "exit-plan"));
  });

  it("repairs historical ExitPlanMode tool calls that are missing tool output", async () => {
    const cwd = await workspace();
    const legacy = new ToolRegistry();
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } }), { request: "build" });
    assert.ok(planning.planState);
    await writePlan(planning.planState.planFilePath, "# Plan\n\nApprove me.\n");
    const broken = {
      ...planning,
      messages: [
        { role: "user" as const, content: "plan this" },
        { role: "assistant" as const, content: "", tool_calls: [{ id: "exit-plan", name: "ExitPlanMode", input: {} }] },
        { role: "user" as const, content: "输出中文方案" }
      ]
    };
    const provider: ModelProvider = {
      async generate(request) {
        assertToolCallsClosed(request.messages);
        assert.ok(request.messages.some((message) => message.role === "tool" && message.tool_call_id === "exit-plan"));
        return { content: "继续规划。" };
      }
    };

    const result = await new QueryEngine().run({
      session: broken,
      provider,
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(result.session.status, "idle_input");
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

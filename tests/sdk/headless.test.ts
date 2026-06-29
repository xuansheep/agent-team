import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPlanFilePath } from "../../src/plans/planFiles.js";
import { headlessQuery } from "../../src/sdk/headless.js";
import { createLocalToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import { Tool } from "../../src/tools/types.js";
import { ModelProvider } from "../../src/providers/types.js";

describe("headless SDK", () => {
  it("returns structured events for a headless query", async () => {
    const provider: ModelProvider = { async generate() { return { content: "ready" }; } };

    const result = await headlessQuery({
      sessionId: "sdk-session",
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider,
      cwd: process.cwd()
    });

    assert.equal(result.status, "completed");
    assert.equal(result.sessionId, "sdk-session");
    assert.deepEqual(result.events.map((event) => event.type), ["runtime_turn_started", "runtime_assistant_message"]);
    assert.equal(result.messages.at(-1)?.content, "ready");
  });

  it("uses permission callback to allow requested tools", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: "need tool", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
        return { content: "done" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(echoTool);

    const result = await headlessQuery({
      messages: [{ role: "user", content: "use tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { ask: ["Echo"] },
      cwd: process.cwd(),
      permissionCallback: (request) => request.tool === "Echo" ? "allow" : "deny"
    });

    assert.equal(result.status, "completed");
    assert.equal(result.messages.at(-1)?.content, "done");
    assert.ok(result.events.some((event) => event.type === "runtime_permission_requested"));
    assert.ok(result.events.some((event) => event.type === "runtime_permission_resolved" && event.decision === "allow"));
  });

  it("uses permission callback to deny requested tools", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: "need tool", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(echoTool);

    const result = await headlessQuery({
      messages: [{ role: "user", content: "use tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { ask: ["Echo"] },
      cwd: process.cwd(),
      permissionCallback: () => "deny"
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /callback denied/);
  });

  it("carries Plan Mode state into headless turns for ExitPlanMode approval", async () => {
    const cwd = process.cwd();
    const sessionId = "sdk-headless-plan";
    const planFilePath = getPlanFilePath(sessionId, cwd);
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "ready for approval",
          tool_calls: [{ id: "call-exit-plan", name: "ExitPlanMode", input: { plan: "# Plan\nDo it carefully." } }]
        };
      }
    };

    const result = await headlessQuery({
      sessionId,
      messages: [{ role: "user", content: "plan first" }],
      model: "test-model",
      provider,
      tools: createLocalToolRegistry(),
      permissions: { mode: "plan" },
      planState: {
        mode: "planning",
        sessionId,
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "plan first" },
        useAutoModeDuringPlan: true,
        feedbackMessages: []
      },
      cwd
    });

    assert.equal(result.status, "waiting_plan_approval");
    assert.equal(result.plan?.document, "# Plan\nDo it carefully.");
    assert.equal(result.planState?.mode, "waiting_approval");
    assert.ok(result.events.some((event) => event.type === "plan_approval_requested"));
  });
});

const echoTool: Tool = {
  name: "Echo",
  description: "Echo",
  input_schema: {},
  async execute(input) {
    return { output: String((input as { value?: unknown }).value ?? "") };
  }
};

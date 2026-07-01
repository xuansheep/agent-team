import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeTurnExecutor } from "../../src/runtime/turnExecutor.js";
import { ModelProvider } from "../../src/providers/types.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { bashTool } from "../../src/tools/local/bash.js";
import { askUserQuestionTool } from "../../src/tools/local/askUserQuestion.js";
import { enterPlanModeTool } from "../../src/tools/local/enterPlanMode.js";
import { exitPlanModeTool } from "../../src/tools/local/exitPlanMode.js";
import { todoWriteTool } from "../../src/tools/local/todoWrite.js";
import { writeTool as localWriteTool } from "../../src/tools/local/write.js";
import { Tool } from "../../src/tools/types.js";

describe("RuntimeTurnExecutor", () => {
  it("returns completed for a provider response without tools and preserves the assistant message", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: "ready" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(result.messages.at(-1)?.content, "ready");
  });

  it("executes tool calls and appends tool results before the final assistant message", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return { content: "checking", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
        }
        assert.equal(request.messages.at(-1)?.role, "tool");
        assert.match(String(request.messages.at(-1)?.content), /ok/);
        return { content: "done" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(echoTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "use a tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: ["Echo"], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(result.messages.at(-1)?.content, "done");
  });

  it("injects long tool prompts into system messages while keeping provider tool descriptions short", async () => {
    let capturedSystem = "";
    let capturedDescription = "";
    const provider: ModelProvider = {
      async generate(request) {
        capturedSystem = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
        capturedDescription = request.tools.find((tool) => tool.name === "PromptedTool")?.description ?? "";
        return { content: "ready" };
      }
    };
    const tools = new ToolRegistry();
    tools.add({
      name: "PromptedTool",
      description: "Short provider description",
      prompt: "Long model-facing tool prompt.",
      input_schema: {},
      async execute() {
        return { output: "" };
      }
    });

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-tool-prompts"
    });

    assert.equal(result.status, "completed");
    assert.equal(capturedDescription, "Short provider description");
    assert.match(capturedSystem, /ATTACHMENT tool_prompts/);
    assert.match(capturedSystem, /### PromptedTool/);
    assert.match(capturedSystem, /Long model-facing tool prompt/);
    assert.doesNotMatch(capturedSystem, /Short provider description/);
  });

  it("runs a plan mode conversation turn without a workflow runner", async () => {
    let workflowRuns = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "Plan draft only." };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before execution" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-plan"
    });

    assert.equal(result.status, "completed");
    assert.equal(result.messages.at(-1)?.content, "Plan draft only.");
    assert.equal(workflowRuns, 0);
  });

  it("returns Plan Mode Bash denials as model-readable tool results", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Permission denied for Bash: Plan Mode blocks shell execution/);
          return { content: "Continuing with read-only planning." };
        }
        return { content: "checking workspace", tool_calls: [{ id: "call-bash", name: "Bash", input: { command: "pwd", timeout_ms: 30000 } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(bashTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "inspect before planning" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-plan-bash"
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(result.messages.at(-1)?.content, "Continuing with read-only planning.");
  });

  it("accepts tui-code style EnterPlanMode calls during plan mode turns", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return { content: "switching to plan mode", tool_calls: [{ id: "call-enter-plan", name: "EnterPlanMode", input: {} }] };
        }
        assert.equal(request.messages.at(-1)?.role, "tool");
        assert.match(String(request.messages.at(-1)?.content), /Entered plan mode/);
        assert.match(String(request.messages.at(-1)?.content), /source files are forbidden/i);
        assert.match(String(request.messages.at(-1)?.content), /only the current plan file is editable/i);
        assert.doesNotMatch(String(request.messages.at(-1)?.content), /^\{"output":/);
        return { content: "Continuing planning." };
      }
    };
    const tools = new ToolRegistry();
    tools.add(enterPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before execution" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan-enter",
      planState: {
        mode: "planning",
        sessionId: "session-plan-enter",
        planFilePath: ".session/plans/session-1.md",
        prePlanMode: "default",
        originalInput: { request: "plan before execution" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(result.messages.at(-1)?.content, "Continuing planning.");
  });

  it("continues planning after non-read-only Bash is denied in Plan Mode", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Permission denied for Bash: Plan Mode blocks shell execution/);
          return { content: "Tests are part of the verification plan." };
        }
        return { content: "running tests", tool_calls: [{ id: "call-bash", name: "Bash", input: { command: "npm test", timeout_ms: 30000 } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(bashTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before running tests" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-plan-bash-deny"
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(result.messages.at(-1)?.content, "Tests are part of the verification plan.");
  });

  it("continues planning after destructive Bash is denied in Plan Mode", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Permission denied for Bash: Plan Mode blocks shell execution/);
          return { content: "Destructive commands remain out of scope while planning." };
        }
        return { content: "resetting", tool_calls: [{ id: "call-bash", name: "Bash", input: { command: "git reset --hard", timeout_ms: 30000 } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(bashTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before changing files" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-plan-bash-destructive-deny"
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(result.messages.at(-1)?.content, "Destructive commands remain out of scope while planning.");
  });

  it("denies TodoWrite in plan mode and asks the model to maintain the plan file", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return {
            content: "tracking planning tasks",
            tool_calls: [{
              id: "call-todos",
              name: "TodoWrite",
              input: { todos: [{ content: "Inspect the TUI plan path", status: "pending" }] }
            }]
          };
        }
        assert.equal(request.messages.at(-1)?.role, "tool");
        assert.match(String(request.messages.at(-1)?.content), /Permission denied for TodoWrite: Plan Mode allows only read-only tools and the current plan file/);
        return { content: "Planning tasks must be captured in the plan file." };
      }
    };
    const tools = new ToolRegistry();
    tools.add(todoWriteTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan with todos" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan-todos",
      planState: {
        mode: "planning",
        sessionId: "session-plan-todos",
        planFilePath: ".session/plans/session-1.md",
        prePlanMode: "default",
        originalInput: { request: "plan with todos" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.equal(result.messages.at(-1)?.content, "Planning tasks must be captured in the plan file.");
  });

  it("does not write TodoWrite artifacts while plan mode is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-plan-todos-"));
    const result = await todoWriteTool.execute(
      { todos: [{ content: "Inspect the TUI plan path", status: "pending" }] },
      {
        cwd,
        runDir: cwd,
        planState: {
          mode: "planning",
          sessionId: "session-plan-todos",
          planFilePath: ".session/plans/session-1.md",
          prePlanMode: "default",
          originalInput: { request: "plan with todos" },
          feedbackMessages: []
        }
      }
    );

    assert.match(result.output ?? "", /Inspect the TUI plan path/);
    await assert.rejects(() => stat(join(cwd, "artifacts", "todos", "todos.json")), /ENOENT/);
  });

  it("waits for user input when AskUserQuestion is called in plan mode", async () => {
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Need one choice.",
          tool_calls: [{
            id: "call-question",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which rollout path?",
                header: "Rollout",
                options: [
                  { label: "Staged", description: "Release gradually" },
                  { label: "Big bang", description: "Release at once" }
                ]
              }]
            }
          }]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(askUserQuestionTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan rollout" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan-question"
    });

    assert.equal(result.status, "waiting_user_input");
    if (result.status !== "waiting_user_input") return;
    assert.equal(result.request.toolCallId, "call-question");
    assert.deepEqual(result.request.questions, [{
      question: "Which rollout path?",
      header: "Rollout",
      options: [
        { label: "Staged", description: "Release gradually", value: "Staged" },
        { label: "Big bang", description: "Release at once", value: "Big bang" }
      ],
      multiSelect: false,
      id: "Rollout",
      text: "Which rollout path?",
      required: true,
      allow_freeform: true
    }]);
    assert.equal(result.messages.at(-1)?.role, "assistant");
    assert.equal(result.messages.at(-1)?.tool_calls?.[0]?.name, "AskUserQuestion");
    assert.ok(result.messages.some((message) => message.role === "system"));
  });

  it("defers tool calls after AskUserQuestion until the user answers", async () => {
    let afterQuestionExecutions = 0;
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Need one choice before continuing.",
          tool_calls: [
            {
              id: "call-question",
              name: "AskUserQuestion",
              input: {
                questions: [{
                  question: "Which rollout path?",
                  header: "Rollout",
                  options: [
                    { label: "Staged", description: "Release gradually" },
                    { label: "Big bang", description: "Release at once" }
                  ]
                }]
              }
            },
            { id: "call-after-question", name: "ReadAfterQuestion", input: {} }
          ]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(askUserQuestionTool);
    tools.add({
      name: "ReadAfterQuestion",
      description: "Should wait for the user's answer.",
      input_schema: {},
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute() {
        afterQuestionExecutions += 1;
        return { output: "after" };
      }
    });

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan rollout" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan-question-defer"
    });

    assert.equal(result.status, "waiting_user_input");
    assert.equal(afterQuestionExecutions, 0);
    assert.deepEqual(result.messages.at(-1)?.tool_calls?.map((call) => call.name), ["AskUserQuestion"]);
  });

  it("does not execute ordinary plan-mode tool calls before AskUserQuestion is resolved", async () => {
    let beforeQuestionExecutions = 0;
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Need one choice before continuing.",
          tool_calls: [
            { id: "call-before-question", name: "ReadBeforeQuestion", input: {} },
            {
              id: "call-question",
              name: "AskUserQuestion",
              input: {
                questions: [{
                  question: "Which rollout path?",
                  header: "Rollout",
                  options: [
                    { label: "Staged", description: "Release gradually" },
                    { label: "Big bang", description: "Release at once" }
                  ]
                }]
              }
            }
          ]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add({
      name: "ReadBeforeQuestion",
      description: "Should wait for the user's answer because a user interaction is pending.",
      input_schema: {},
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute() {
        beforeQuestionExecutions += 1;
        return { output: "before" };
      }
    });
    tools.add(askUserQuestionTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan rollout" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan-question-before-defer"
    });

    assert.equal(result.status, "waiting_user_input");
    assert.equal(beforeQuestionExecutions, 0);
    assert.deepEqual(result.messages.at(-1)?.tool_calls?.map((call) => call.name), ["AskUserQuestion"]);
  });

  it("returns a model-readable ExitPlanMode pending approval result instead of internal JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-exit-plan-"));
    const planFilePath = getPlanFilePath("session-plan-exit", cwd);
    await writePlan(planFilePath, "# Plan\n\nImplement carefully.\n");
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Ready for approval.",
          tool_calls: [{ id: "call-exit-plan", name: "ExitPlanMode", input: {} }]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(exitPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before implementation" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-exit",
      planState: {
        mode: "planning",
        sessionId: "session-plan-exit",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "plan before implementation" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "waiting_plan_approval");
    const toolMessage = result.messages.at(-1);
    assert.equal(toolMessage?.role, "tool");
    assert.match(String(toolMessage?.content), /Plan approval has been requested from the user/);
    assert.match(String(toolMessage?.content), /Wait for the user's approval or feedback/);
    assert.match(String(toolMessage?.content), new RegExp(escapeRegExp(planFilePath)));
    assert.doesNotMatch(String(toolMessage?.content), /^\{"output":/);
    assert.doesNotMatch(String(toolMessage?.content), /"plan_approval_requested"/);
  });

  it("executes plan-file writes before ExitPlanMode approval in the same assistant turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-write-exit-plan-"));
    const planFilePath = getPlanFilePath("session-plan-write-exit", cwd);
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Writing plan and requesting approval.",
          tool_calls: [
            { id: "call-write-plan", name: "Write", input: { file_path: planFilePath, content: "# Plan\n\nWrite this first.\n" } },
            { id: "call-exit-plan", name: "ExitPlanMode", input: {} }
          ]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(localWriteTool);
    tools.add(exitPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before implementation" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-write-exit",
      planState: {
        mode: "planning",
        sessionId: "session-plan-write-exit",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "plan before implementation" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "waiting_plan_approval");
    assert.equal(await readPlan(planFilePath), "# Plan\n\nWrite this first.\n");
    assert.equal(result.status === "waiting_plan_approval" ? result.plan.empty : true, undefined);
    assert.deepEqual(result.messages.filter((message) => message.role === "assistant").at(-1)?.tool_calls?.map((call) => call.name), ["Write", "ExitPlanMode"]);
  });

  it("defers tool calls after ExitPlanMode until the plan is approved", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-exit-plan-defer-"));
    const planFilePath = getPlanFilePath("session-plan-exit-defer", cwd);
    await writePlan(planFilePath, "# Plan\n\nImplement carefully.\n");
    let afterApprovalExecutions = 0;
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Ready for approval.",
          tool_calls: [
            { id: "call-exit-plan", name: "ExitPlanMode", input: {} },
            { id: "call-after-approval", name: "ReadAfterApproval", input: {} }
          ]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(exitPlanModeTool);
    tools.add({
      name: "ReadAfterApproval",
      description: "Should wait for plan approval.",
      input_schema: {},
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute() {
        afterApprovalExecutions += 1;
        return { output: "after" };
      }
    });

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before implementation" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-exit-defer",
      planState: {
        mode: "planning",
        sessionId: "session-plan-exit-defer",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "plan before implementation" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "waiting_plan_approval");
    assert.equal(afterApprovalExecutions, 0);
    assert.deepEqual(result.messages.filter((message) => message.role === "assistant").at(-1)?.tool_calls?.map((call) => call.name), ["ExitPlanMode"]);
  });

  it("rejects ExitPlanMode outside Plan Mode without waiting for permission", async () => {
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Trying to exit plan mode.",
          tool_calls: [{ id: "call-exit-plan-outside", name: "ExitPlanMode", input: {} }]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(exitPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "continue implementation" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: [], ask: ["ExitPlanMode"], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-exit-plan-outside"
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /Permission denied for ExitPlanMode/);
    assert.match(result.error ?? "", /You are not in plan mode/);
  });

  it("ignores hidden ExitPlanMode plan input and reads the approval document from the plan file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-exit-plan-edit-"));
    const planFilePath = getPlanFilePath("session-plan-exit-edit", cwd);
    await writePlan(planFilePath, "# Plan\n\nOriginal draft.\n");
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Ready for approval.",
          tool_calls: [{
            id: "call-exit-plan",
            name: "ExitPlanMode",
            input: { plan: "# Edited Plan\n\nUse the reviewed approach.", planFilePath }
          }]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(exitPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan before implementation" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-exit-edit",
      planState: {
        mode: "planning",
        sessionId: "session-plan-exit-edit",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "plan before implementation" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "waiting_plan_approval");
    if (result.status !== "waiting_plan_approval") return;
    assert.equal("document" in result.plan, false);
    assert.equal(await readPlan(planFilePath), "# Plan\n\nOriginal draft.\n");
  });

  it("accepts tui-code style AskUserQuestion input", async () => {
    const provider: ModelProvider = {
      async generate() {
        return {
          content: "Need one choice.",
          tool_calls: [{
            id: "call-question",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which rollout path?",
                header: "Rollout",
                options: [
                  { label: "Staged", description: "Release gradually", preview: "phase 1\nphase 2" },
                  { label: "Big bang", description: "Release at once" }
                ]
              }]
            }
          }]
        };
      }
    };
    const tools = new ToolRegistry();
    tools.add(askUserQuestionTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan rollout" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-plan-question"
    });

    assert.equal(result.status, "waiting_user_input");
    if (result.status !== "waiting_user_input") return;
    assert.deepEqual(result.request.questions, [{
      question: "Which rollout path?",
      header: "Rollout",
      options: [
        { label: "Staged", description: "Release gradually", preview: "phase 1\nphase 2", value: "Staged" },
        { label: "Big bang", description: "Release at once", value: "Big bang" }
      ],
      multiSelect: false,
      id: "Rollout",
      text: "Which rollout path?",
      required: true,
      allow_freeform: true
    }]);
  });

  it("runs concurrency-safe tool calls in parallel through the runtime executor", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            content: "checking",
            tool_calls: [
              { id: "call-1", name: "ReadOne", input: {} },
              { id: "call-2", name: "ReadTwo", input: {} },
              { id: "call-3", name: "ReadThree", input: {} }
            ]
          };
        }
        return { content: "done" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(delayedReadTool("ReadOne"));
    tools.add(delayedReadTool("ReadTwo"));
    tools.add(delayedReadTool("ReadThree"));

    const startedAt = Date.now();
    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "use tools" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: ["ReadOne", "ReadTwo", "ReadThree"], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.ok(Date.now() - startedAt < 180);
    assert.equal(result.messages.filter((message) => message.role === "tool").length, 3);
  });

  it("returns waiting_permission before executing tools that require approval", async () => {
    let executions = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "checking", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add({
      ...echoTool,
      async execute(input, context) {
        executions += 1;
        return echoTool.execute(input, context);
      }
    });

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "use a tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: [], ask: ["Echo"], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-ask"
    });

    assert.equal(result.status, "waiting_permission");
    assert.equal(executions, 0);
  });

  it("emits model usage events for audit and session metadata sinks", async () => {
    const events: unknown[] = [];
    const provider: ModelProvider = {
      async generate() {
        return { content: "ready", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, stopReason: "stop" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-usage",
      eventSink: (event) => { events.push(event); }
    });

    assert.deepEqual(events.find((event) => (event as { type?: string }).type === "runtime_model_usage"), {
      type: "runtime_model_usage",
      session_id: "session-usage",
      run_id: undefined,
      model: "test-model",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      stop_reason: "stop"
    });
  });

  it("returns Plan Mode write denials as tool results and continues to plan approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-plan-write-deny-"));
    const planFilePath = getPlanFilePath("session-plan-write-deny", cwd);
    await writePlan(planFilePath, "# Plan\n\nRemove the edges node after approval.\n");
    let calls = 0;
    let executions = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Permission denied for Write: Plan Mode writes are limited to the current plan file/);
          return {
            content: "Ready for approval.",
            tool_calls: [{ id: "call-exit-plan", name: "ExitPlanMode", input: {} }]
          };
        }
        return { content: "writing", tool_calls: [{ id: "call-1", name: "Write", input: { file_path: "src/index.ts", content: "x" } }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(writeTool(() => { executions += 1; }));
    tools.add(exitPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan only" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-write-deny",
      planState: {
        mode: "planning",
        sessionId: "session-plan-write-deny",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "plan only" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "waiting_plan_approval");
    assert.equal(calls, 2);
    assert.equal(executions, 0);
    assert.equal(result.status === "waiting_plan_approval" ? "document" in result.plan : false, false);
    assert.match((await readPlan(planFilePath)) ?? "", /Remove the edges node/);
  });


  it("normalizes Plan Mode Write calls to the current plan file after empty ExitPlanMode is blocked", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-plan-normalize-write-"));
    const planFilePath = getPlanFilePath("session-plan-normalize-write", cwd);
    const truncatedPlanFilePath = planFilePath.slice(0, Math.max(3, Math.floor(planFilePath.length / 3)));
    let calls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        calls += 1;
        if (calls === 1) {
          return { content: "Requesting approval too early.", tool_calls: [{ id: "call-empty-exit", name: "ExitPlanMode", input: {} }] };
        }
        if (calls === 2) {
          assert.equal(request.messages.at(-1)?.role, "tool");
          assert.match(String(request.messages.at(-1)?.content), /Please write your plan to this file before calling ExitPlanMode/);
          return { content: "Writing the missing plan.", tool_calls: [{ id: "call-write-plan", name: "Write", input: { file_path: truncatedPlanFilePath, content: "# Plan\n\nRemove workflows.delivery.edges after approval.\n" } }] };
        }
        return { content: "Requesting approval.", tool_calls: [{ id: "call-exit-plan", name: "ExitPlanMode", input: {} }] };
      }
    };
    const tools = new ToolRegistry();
    tools.add(localWriteTool);
    tools.add(exitPlanModeTool);

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "remove edges" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-normalize-write",
      planState: {
        mode: "planning",
        sessionId: "session-plan-normalize-write",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "remove edges" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "waiting_plan_approval");
    assert.equal(calls, 3);
    assert.equal(await readPlan(planFilePath), "# Plan\n\nRemove workflows.delivery.edges after approval.\n");
    const writeCall = result.messages.flatMap((message) => message.role === "assistant" ? message.tool_calls ?? [] : []).find((call) => call.id === "call-write-plan");
    assert.equal((writeCall?.input as { file_path?: unknown } | undefined)?.file_path, planFilePath);
  });

  it("stops Plan Mode plain-text repair after two reminders instead of looping until max iterations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-runtime-plan-repair-limit-"));
    const planFilePath = getPlanFilePath("session-plan-repair-limit", cwd);
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        return { content: "当前处于 Plan Mode，我不能修改源码文件，请你手动删除这段代码。" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "remove edges" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-plan-repair-limit",
      planState: {
        mode: "planning",
        sessionId: "session-plan-repair-limit",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "remove edges" },
        feedbackMessages: []
      }
    });

    assert.equal(result.status, "completed");
    assert.equal(calls, 3);
    assert.equal(result.messages.filter((message) => message.role === "system" && String(message.content).includes("Plan Mode is still active")).length, 2);
  });

});

const echoTool: Tool = {
  name: "Echo",
  description: "Returns the provided value.",
  input_schema: {},
  async execute(input) {
    return { output: String((input as { value?: unknown }).value ?? "") };
  }
};

function delayedReadTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { output: name };
    }
  };
}

function writeTool(onExecute: () => void): Tool {
  return {
    name: "Write",
    description: "Write a file.",
    input_schema: {},
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    writesPlanFile(input) {
      return String((input as { file_path?: unknown }).file_path ?? "").startsWith(".session/plans/");
    },
    async execute() {
      onExecute();
      return { output: "wrote" };
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

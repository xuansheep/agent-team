import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAutoModeAttachment, buildPlanModeAttachment, buildPlanModeReentryAttachment, buildToolPromptsAttachment, hasRuntimeAttachment } from "../../src/context/attachments.js";
import { buildNodeMessages } from "../../src/harness/context.js";
import { planModeExitHandoffMarker, planModeExitPlanExistsMarker } from "../../src/plans/planSession.js";
import { RuntimeTurnExecutor } from "../../src/runtime/turnExecutor.js";
import { ModelMessage, ModelProvider } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-context-"));
}

describe("runtime context attachments", () => {
  it("injects full Auto Mode instructions on the first auto turn", async () => {
    let systemContent = "";
    const provider: ModelProvider = {
      async generate(request) {
        systemContent = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
        return { content: "working" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "implement this" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "auto", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-auto"
    });

    assert.equal(result.status, "completed");
    assert.match(systemContent, /ATTACHMENT auto_mode/);
    assert.match(systemContent, /## Auto Mode Active/);
    assert.match(systemContent, /Execute immediately/);
    assert.match(systemContent, /Minimize interruptions/);
    assert.match(systemContent, /Auto mode is not a license to destroy/);
  });

  it("injects sparse Auto Mode reminders only after five human turns", async () => {
    const attachment = buildAutoModeAttachment({ sparse: false });
    const priorMessages = [
      { role: "system" as const, content: attachment.content, metadata: { runtimeAttachment: { type: attachment.type, humanTurnCount: 0 } } },
      { role: "user" as const, content: "implement this" },
      { role: "assistant" as const, content: "working" },
      { role: "user" as const, content: "revise it" },
      { role: "assistant" as const, content: "revised" },
      { role: "user" as const, content: "add tests" },
      { role: "assistant" as const, content: "added" },
      { role: "user" as const, content: "include risks" },
      { role: "assistant" as const, content: "included" },
      { role: "user" as const, content: "final check" }
    ];
    let systemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        return { content: "working" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages: priorMessages,
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "auto", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-auto"
    });

    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT auto_mode").length, 1);
    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT auto_mode_reminder").length, 1);
    assert.ok(systemMessages.some((content) => /Auto mode still active/.test(content)));
  });

  it("injects Auto Mode exit guidance once after leaving auto mode", async () => {
    const autoAttachment = buildAutoModeAttachment({ sparse: false });
    const priorMessages: ModelMessage[] = [
      { role: "system", content: autoAttachment.content, metadata: { runtimeAttachment: { type: autoAttachment.type, humanTurnCount: 0 } } },
      { role: "user", content: "implement this" },
      { role: "assistant", content: "working" }
    ];
    let firstSystemMessages: string[] = [];
    let secondSystemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        const systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        if (!firstSystemMessages.length) firstSystemMessages = systemMessages;
        else secondSystemMessages = systemMessages;
        return { content: "manual mode" };
      }
    };

    const first = await new RuntimeTurnExecutor().execute({
      messages: [...priorMessages, { role: "user", content: "slow down" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-auto-exit"
    });

    assert.equal(first.status, "completed");
    assert.equal(firstSystemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT auto_mode_exit").length, 1);
    assert.ok(firstSystemMessages.some((content) => /Auto mode is no longer active/.test(content)));

    await new RuntimeTurnExecutor().execute({
      messages: [...first.messages, { role: "user", content: "continue manually" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "default", allow: [], ask: [], deny: [] },
      cwd: process.cwd(),
      sessionId: "session-auto-exit"
    });

    assert.equal(secondSystemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT auto_mode_exit").length, 1);
  });

  it("injects Auto Mode instructions into workflow node messages when the run uses auto mode", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { request: "build" },
      { permissionMode: "auto" }
    );

    const system = messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
    assert.match(system, /ATTACHMENT auto_mode/);
    assert.match(system, /## Auto Mode Active/);
    assert.match(system, /Execute immediately/);
  });

  it("injects full Plan Mode instructions without exposing the current draft on the first planning turn", async () => {
    const cwd = await workspace();
    const planFilePath = join(cwd, ".session", "plans", "session-1.md");
    await mkdir(join(cwd, ".session", "plans"), { recursive: true });
    await writeFile(planFilePath, "# Draft\n\nRead first.\n", "utf8");
    let systemContent = "";
    const provider: ModelProvider = {
      async generate(request) {
        systemContent = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
        return { content: "planning" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "make a plan" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.match(systemContent, /ATTACHMENT plan_mode/);
    assert.match(systemContent, /Plan File Info/);
    assert.match(systemContent, /previous plan exists/i);
    assert.match(systemContent, /Edit or MultiEdit/);
    assert.match(systemContent, /MUST NOT make edits/);
    assert.match(systemContent, /sole exception of the current plan file/);
    assert.match(systemContent, /Iterative Planning Workflow/);
    assert.match(systemContent, /First Turn/);
    assert.match(systemContent, /Plan File Structure/);
    assert.match(systemContent, /When to Converge/);
    assert.match(systemContent, /Plan mode is active/i);
    assert.match(systemContent, /Current plan file:/);
    assert.match(systemContent, /only file you are allowed to edit/i);
    assert.match(systemContent, /AskUserQuestion/);
    assert.match(systemContent, /ExitPlanMode/);
    assert.match(systemContent, /call ExitPlanMode/);
    assert.match(systemContent, /Do NOT ask about plan approval via text or AskUserQuestion/);
    assert.doesNotMatch(systemContent, /ExitPlanMode\.plan/);
    assert.doesNotMatch(systemContent, /Pass the complete plan/);
    assert.doesNotMatch(systemContent, /# Draft/);
    assert.doesNotMatch(systemContent, /Read first\./);
  });

  it("tells the model to create the plan file when no plan exists yet", () => {
    const attachment = buildPlanModeAttachment({ sessionId: "session-1", planFilePath: ".session/plans/session-1.md" });

    assert.match(attachment.content, /No plan has been saved yet/);
    assert.match(attachment.content, /Create your plan at \.session\/plans\/session-1\.md using Write/);
    assert.match(attachment.content, /Current plan file:/);
    assert.match(attachment.content, /only file you are allowed to edit/i);
    assert.match(attachment.content, /AskUserQuestion/);
    assert.match(attachment.content, /ExitPlanMode/);
    assert.doesNotMatch(attachment.content, /ExitPlanMode\.plan/);
    assert.doesNotMatch(attachment.content, /Pass the complete plan/);
  });

  it("keeps Auto Mode instructions visible during Plan Mode when entered from auto", async () => {
    const cwd = await workspace();
    const planFilePath = join(cwd, ".session", "plans", "session-auto-plan.md");
    let systemContent = "";
    const provider: ModelProvider = {
      async generate(request) {
        systemContent = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
        return { content: "planning under auto" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan this autonomous task" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", prePlanMode: "auto", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-auto-plan"
    });

    assert.equal(result.status, "completed");
    assert.match(systemContent, /ATTACHMENT plan_mode/);
    assert.match(systemContent, /ATTACHMENT auto_mode/);
    assert.match(systemContent, /Plan mode is active/);
    assert.match(systemContent, /Auto mode is active/);
  });

  it("suppresses Auto Mode instructions during Plan Mode when useAutoModeDuringPlan is disabled", async () => {
    const cwd = await workspace();
    const planFilePath = join(cwd, ".session", "plans", "session-auto-plan-disabled.md");
    let systemContent = "";
    const provider: ModelProvider = {
      async generate(request) {
        systemContent = request.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
        return { content: "planning without auto semantics" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "plan this autonomous task" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", prePlanMode: "auto", planUseAutoMode: false, allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-auto-plan-disabled"
    });

    assert.equal(result.status, "completed");
    assert.match(systemContent, /ATTACHMENT plan_mode/);
    assert.doesNotMatch(systemContent, /ATTACHMENT auto_mode/);
    assert.doesNotMatch(systemContent, /Auto mode is active/);
  });

  it("builds tool prompt attachments separately from short tool descriptions", () => {
    const attachment = buildToolPromptsAttachment({
      tools: [{
        name: "ExitPlanMode",
        description: "Short description",
        prompt: "Long model-facing prompt.",
        input_schema: {},
        async execute() {
          return { output: "" };
        }
      }]
    });

    assert.equal(attachment?.type, "tool_prompts");
    assert.match(attachment?.content ?? "", /ATTACHMENT tool_prompts/);
    assert.match(attachment?.content ?? "", /### ExitPlanMode/);
    assert.match(attachment?.content ?? "", /Long model-facing prompt/);
    assert.doesNotMatch(attachment?.content ?? "", /Short description/);
  });

  it("builds Plan Mode re-entry guidance aligned with tui-code", () => {
    const attachment = buildPlanModeReentryAttachment({ planFilePath: ".session/plans/session-1.md" });

    assert.equal(attachment.type, "plan_mode_reentry");
    assert.match(attachment.content, /ATTACHMENT plan_mode_reentry/);
    assert.match(attachment.content, /## Re-entering Plan Mode/);
    assert.match(attachment.content, /previously exited it/);
    assert.match(attachment.content, /Read the existing plan file/);
    assert.match(attachment.content, /Different task/);
    assert.match(attachment.content, /Same task, continuing/);
    assert.match(attachment.content, /edit the current plan file with the revised complete plan/);
    assert.match(attachment.content, /call ExitPlanMode with no plan text/);
    assert.doesNotMatch(attachment.content, /ExitPlanMode\.plan/);
    assert.match(attachment.content, /Do not assume the existing plan is relevant/);
  });

  it("injects Plan Mode re-entry guidance once before normal plan instructions", async () => {
    const cwd = await workspace();
    const planFilePath = join(cwd, ".session", "plans", "session-1.md");
    await mkdir(join(cwd, ".session", "plans"), { recursive: true });
    await writeFile(planFilePath, "# Previous Plan\n\nOld notes.\n", "utf8");
    let firstSystemMessages: string[] = [];
    let secondSystemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        const systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        if (!firstSystemMessages.length) firstSystemMessages = systemMessages;
        else secondSystemMessages = systemMessages;
        return { content: "planning" };
      }
    };

    const first = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "replan this" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-1",
      planState: {
        mode: "planning",
        sessionId: "session-1",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "replan this" },
        reentry: true
      }
    });

    assert.equal(first.status, "completed");
    assert.ok(firstSystemMessages.some((content) => /ATTACHMENT plan_mode_reentry/.test(content)));
    assert.ok(firstSystemMessages.some((content) => /ATTACHMENT plan_mode/.test(content)));

    await new RuntimeTurnExecutor().execute({
      messages: [...first.messages, { role: "user", content: "continue" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-1",
      planState: {
        mode: "planning",
        sessionId: "session-1",
        planFilePath,
        prePlanMode: "default",
        originalInput: { request: "replan this" },
        reentry: true
      }
    });

    assert.equal(secondSystemMessages.filter((content) => /ATTACHMENT plan_mode_reentry/.test(content)).length, 1);
    assert.equal(secondSystemMessages.filter((content) => /ATTACHMENT plan_mode_reminder/.test(content)).length, 0);
  });

  it("does not repeat Plan Mode reminders before five human turns", async () => {
    const attachment = buildPlanModeAttachment({ sessionId: "session-1", planFilePath: ".session/plans/session-1.md", draft: "# Draft", sparse: false });
    const priorMessages = [
      { role: "system" as const, content: attachment.content },
      { role: "user" as const, content: "make a plan" },
      { role: "assistant" as const, content: "drafted" },
      { role: "user" as const, content: "revise it" }
    ];
    let systemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        return { content: "revised" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages: priorMessages,
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode").length, 1);
    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode_reminder").length, 0);
  });

  it("injects a sparse Plan Mode reminder after five human turns", async () => {
    const attachment = buildPlanModeAttachment({ sessionId: "session-1", planFilePath: ".session/plans/session-1.md", draft: "# Draft", sparse: false });
    const priorMessages = [
      { role: "system" as const, content: attachment.content },
      { role: "user" as const, content: "make a plan" },
      { role: "assistant" as const, content: "drafted" },
      { role: "user" as const, content: "revise it" },
      { role: "assistant" as const, content: "revised" },
      { role: "user" as const, content: "add tests" },
      { role: "assistant" as const, content: "added" },
      { role: "user" as const, content: "include risks" },
      { role: "assistant" as const, content: "included" },
      { role: "user" as const, content: "final check" }
    ];
    let systemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        return { content: "revised" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages: priorMessages,
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode").length, 1);
    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode_reminder").length, 1);
    assert.ok(systemMessages.some((content) => /Plan mode still active/i.test(content)));
    assert.ok(systemMessages.some((content) => /Follow the iterative workflow/i.test(content)));
    assert.ok(systemMessages.some((content) => /AskUserQuestion/i.test(content)));
    assert.ok(systemMessages.some((content) => /ExitPlanMode for plan approval/i.test(content)));
    assert.ok(systemMessages.some((content) => /Call ExitPlanMode only after the current plan file contains the complete plan/i.test(content)));
    assert.ok(systemMessages.some((content) => /Never ask about plan approval via plain text or AskUserQuestion/i.test(content)));
    assert.ok(systemMessages.every((content) => !/ExitPlanMode\.plan/.test(content)));
    assert.ok(systemMessages.every((content) => !/Pass the complete plan/.test(content)));
  });

  it("does not repeat Plan Mode reminders one human turn after a reminder", async () => {
    const planFilePath = ".session/plans/session-1.md";
    let messages: ModelMessage[] = [];
    const capturedSystemMessages: string[][] = [];
    const provider: ModelProvider = {
      async generate(request) {
        capturedSystemMessages.push(request.messages.filter((message) => message.role === "system").map((message) => String(message.content)));
        return { content: "planning" };
      }
    };

    for (const text of ["make a plan", "revise it", "add tests", "include risks", "final check", "one more detail"]) {
      const result = await new RuntimeTurnExecutor().execute({
        messages: [...messages, { role: "user", content: text }],
        model: "test-model",
        provider,
        tools: new ToolRegistry(),
        permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
        cwd: process.cwd(),
        sessionId: "session-1"
      });
      assert.equal(result.status, "completed");
      messages = result.messages;
    }

    const fifthTurnSystem = capturedSystemMessages[4] ?? [];
    const sixthTurnSystem = capturedSystemMessages[5] ?? [];
    assert.equal(fifthTurnSystem.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode_reminder").length, 1);
    assert.equal(sixthTurnSystem.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode_reminder").length, 1);
  });

  it("injects a full Plan Mode reminder on the sixth Plan Mode attachment", async () => {
    const planFilePath = ".session/plans/session-1.md";
    let messages: ModelMessage[] = [];
    const capturedSystemMessages: string[][] = [];
    const provider: ModelProvider = {
      async generate(request) {
        capturedSystemMessages.push(request.messages.filter((message) => message.role === "system").map((message) => String(message.content)));
        return { content: "planning" };
      }
    };

    for (let turn = 1; turn <= 21; turn += 1) {
      const result = await new RuntimeTurnExecutor().execute({
        messages: [...messages, { role: "user", content: `turn ${turn}` }],
        model: "test-model",
        provider,
        tools: new ToolRegistry(),
        permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
        cwd: process.cwd(),
        sessionId: "session-1"
      });
      assert.equal(result.status, "completed");
      messages = result.messages;
    }

    const twentyFirstTurnSystem = capturedSystemMessages[20] ?? [];
    assert.equal(twentyFirstTurnSystem.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode").length, 2);
    assert.ok(twentyFirstTurnSystem.some((content) => /Iterative Planning Workflow/.test(content)));
  });

  it("resets the Plan Mode full reminder cycle after a plan mode exit attachment", async () => {
    const planFilePath = ".session/plans/session-1.md";
    const fullAttachment = buildPlanModeAttachment({ sessionId: "session-1", planFilePath, sparse: false });
    const sparseAttachment = buildPlanModeAttachment({ sessionId: "session-1", planFilePath, sparse: true });
    const messages: ModelMessage[] = [
      { role: "system", content: fullAttachment.content },
      { role: "system", content: sparseAttachment.content },
      { role: "system", content: "ATTACHMENT plan_mode_exit\n## Exited Plan Mode", metadata: { runtimeAttachment: { type: "plan_mode_exit", humanTurnCount: 6 } } },
      { role: "user", content: "re-enter plan mode" },
      { role: "assistant", content: "planning" },
      { role: "user", content: "revise" },
      { role: "assistant", content: "planning" },
      { role: "user", content: "add tests" },
      { role: "assistant", content: "planning" },
      { role: "user", content: "include risks" },
      { role: "assistant", content: "planning" },
      { role: "user", content: "final check" }
    ];
    let systemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        return { content: "planning" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages,
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode").length, 2);
    assert.ok(systemMessages.some((content) => /Iterative Planning Workflow/.test(content)));
  });

  it("injects a plan mode exit attachment once for approved plan workflow handoff", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it.", plan_file_path: ".session/plans/session-1.md" }
    );

    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const secondPass = await buildNodeMessages(
      { id: "next", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { previous_handoff: { instruction: "continue" } }
    );
    const secondSystem = String(secondPass.find((message) => message.role === "system")?.content ?? "");

    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.match(system, /## Exited Plan Mode/);
    assert.match(system, /You have exited plan mode\. You can now make edits, run tools, and take actions\./);
    assert.match(system, /The plan file is located at \.session\/plans\/session-1\.md if you need to reference it\./);
    assert.doesNotMatch(system, /## Approved Plan:/);
    assert.doesNotMatch(system, /Original input:/);
    assert.doesNotMatch(secondSystem, /ATTACHMENT plan_mode_exit/);
  });

  it("injects a plan mode exit attachment for empty-plan approval without exposing internal markers", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { request: "build", [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: false }
    );

    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const user = String(messages.find((message) => message.role === "user")?.content ?? "");

    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.match(system, /You have exited plan mode\. You can now make edits, run tools, and take actions\./);
    assert.doesNotMatch(system, /The plan file is located at/);
    assert.match(user, /"request": "build"/);
    assert.doesNotMatch(user, new RegExp(planModeExitHandoffMarker));
    assert.doesNotMatch(user, new RegExp(planModeExitPlanExistsMarker));
  });

  it("keeps plan approval feedback in the workflow handoff payload", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it.", plan_approval_feedback: "Also update the README." }
    );
    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const user = messages.find((message) => message.role === "user");

    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.doesNotMatch(system, /Also update the README\./);
    assert.match(String(user?.content), /plan_approval_feedback/);
    assert.match(String(user?.content), /Also update the README\./);
  });

  it("keeps approved plan and original input in the workflow handoff payload", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it." }
    );
    const user = messages.find((message) => message.role === "user");

    assert.match(String(user?.content), /approved_plan/);
    assert.match(String(user?.content), /original_input/);
    assert.equal(hasRuntimeAttachment(messages, "plan_mode_exit"), true);
  });

  it("preserves workflow handoff, images, and approved plan context together", async () => {
    const cwd = await workspace();
    const imagePath = join(cwd, "input.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));

    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      {
        original_input: { request: "build" },
        approved_plan: "# Plan\nBuild it.",
        previous_handoff: { instruction: "carry prior context" },
        images: [{ artifact_id: "img-1", path: imagePath, media_type: "image/png" }]
      }
    );
    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const user = messages.find((message) => message.role === "user");

    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.ok(Array.isArray(user?.content));
    const parts = user?.content as Array<{ type: string; text?: string; media_type?: string }>;
    assert.match(String(parts.find((part) => part.type === "text")?.text), /previous_handoff/);
    assert.equal(parts.find((part) => part.type === "image")?.media_type, "image/png");
  });

});

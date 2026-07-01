import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";
import { approvePlan, buildApprovedPlanHandoff, enterPlanMode, exitPlanMode, planModeExitHandoffMarker, planModeExitPlanExistsMarker, readPlanOrRecoverFromTranscript, recoverPlanFromTranscript, resolvePlanApproval, runWorkflowAfterPlanApproval } from "../../src/plans/planSession.js";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { PlanSessionState } from "../../src/plans/planSession.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-plan-mode-"));
}

describe("Plan Mode V2", () => {
  it("returns stable non-conflicting plan file paths per session", async () => {
    const cwd = await workspace();
    const first = getPlanFilePath("session/one", cwd);
    const again = getPlanFilePath("session/one", cwd);
    const other = getPlanFilePath("session-one", cwd);

    assert.equal(first, again);
    assert.notEqual(first, other);
    assert.match(first, /[.]session[\\/]plans[\\/].+[.]md$/);
  });

  it("writes and reads plan drafts", async () => {
    const cwd = await workspace();
    const path = getPlanFilePath("session-1", cwd);
    const draft = "# Plan\n\n1. Think first.\n";

    assert.equal(await readPlan(path), undefined);
    await writePlan(path, draft);
    assert.equal(await readPlan(path), draft);
  });

  it("recovers missing plan files from transcript tool calls", async () => {
    const cwd = await workspace();
    const path = getPlanFilePath("session-1", cwd);
    const messages = [
      {
        role: "assistant" as const,
        content: "writing plan",
        tool_calls: [{ id: "write-plan", name: "Write", input: { file_path: path, content: "# Plan\n\nDo it.\n" } }]
      },
      {
        role: "assistant" as const,
        content: "refining plan",
        tool_calls: [{ id: "edit-plan", name: "Edit", input: { file_path: path, old_string: "Do it.", new_string: "Do it safely." } }]
      }
    ];

    assert.equal(recoverPlanFromTranscript(messages, path, cwd), "# Plan\n\nDo it safely.\n");
    assert.equal(await readPlanOrRecoverFromTranscript({ planFilePath: path, cwd, messages }), "# Plan\n\nDo it safely.\n");
    assert.equal(await readPlan(path), "# Plan\n\nDo it safely.\n");
  });

  it("does not recover plans from ExitPlanMode input plan text", async () => {
    const cwd = await workspace();
    const path = getPlanFilePath("session-no-exit-input-recovery", cwd);
    const messages = [{
      role: "assistant" as const,
      content: "request approval",
      tool_calls: [{ id: "exit-plan", name: "ExitPlanMode", input: { plan: "# Old bypass\n" } }]
    }];

    assert.equal(recoverPlanFromTranscript(messages, path, cwd), undefined);
  });

  it("enters plan mode from default and records pre mode plus original input", async () => {
    const cwd = await workspace();
    const result = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: ["Read"], ask: [], deny: [] }
    });

    assert.equal(result.state.mode, "planning");
    assert.equal(result.state.prePlanMode, "default");
    assert.deepEqual(result.state.originalInput, { request: "build" });
    assert.equal(result.permissions.mode, "plan");
    assert.equal(result.permissions.prePlanMode, "default");
    assert.equal(result.permissions.planFilePath, result.state.planFilePath);
    assert.deepEqual(result.event, { type: "plan_mode_entered", session_id: "session-1", plan_file_path: result.state.planFilePath });
  });

  it("does not run workflow before plan approval", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    let workflowRuns = 0;

    await assert.rejects(() => runWorkflowAfterPlanApproval(state, async () => {
      workflowRuns += 1;
      return "ran";
    }), /approved/);
    assert.equal(workflowRuns, 0);
  });

  it("allows only current plan file writes in plan mode", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const { state, permissions } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    const currentPlanInput = { file_path: state.planFilePath.slice(cwd.length + 1), content: "# Plan" };

    assert.equal((await checkToolPermission(tools.get("Write"), currentPlanInput, { ...permissions, cwd })).decision, "allow");
    assert.equal((await checkToolPermission(tools.get("Write"), { file_path: "README.md", content: "x" }, { ...permissions, cwd })).decision, "deny");
  });

  it("allows current plan file writes when plansDirectory is customized", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const { state, permissions } = enterPlanMode({
      sessionId: "session-custom-plans",
      cwd,
      plansDirectory: ".agent-team/plans",
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    const currentPlanInput = { file_path: state.planFilePath.slice(cwd.length + 1), content: "# Plan" };

    assert.match(state.planFilePath, /[.]agent-team[\\/]plans[\\/].+[.]md$/);
    assert.equal((await checkToolPermission(tools.get("Write"), currentPlanInput, { ...permissions, cwd })).decision, "allow");
    assert.equal((await checkToolPermission(tools.get("Write"), { file_path: ".session/plans/not-current.md", content: "x" }, { ...permissions, cwd })).decision, "deny");
  });

  it("requests a simplified approval when exiting without a written plan", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });

    const result = await exitPlanMode(state);
    const approved = approvePlan(result.state, result.plan.document);
    const resolved = resolvePlanApproval(approved, "continue");

    assert.equal(result.state.mode, "waiting_approval");
    assert.equal(result.plan.document, "");
    assert.equal(result.plan.empty, true);
    assert.equal(result.event.type, "plan_approval_requested");
    assert.equal(result.event.empty, true);
    assert.deepEqual(buildApprovedPlanHandoff(resolved.state), { request: "build", [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: false });
  });

  it("requests approval when exiting with a plan draft", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    await writePlan(state.planFilePath, "# Plan\n\nDo it.\n");

    const result = await exitPlanMode(state);

    assert.equal(result.state.mode, "waiting_approval");
    assert.equal(result.plan.sessionId, "session-1");
    assert.equal(result.plan.document, "# Plan\n\nDo it.");
    assert.equal(result.plan.planFilePath, state.planFilePath);
    assert.deepEqual(result.event, { type: "plan_approval_requested", session_id: "session-1", document: "# Plan\n\nDo it.", plan_file_path: state.planFilePath });
  });

  it("carries ExitPlanMode requested permissions into approval and handoff metadata", async () => {
    const cwd = await workspace();
    const { state } = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    await writePlan(state.planFilePath, "# Plan\n\nDo it.\n");

    const requestedPermissions = [{ tool: "Bash", prompt: "run tests" }];
    const result = await exitPlanMode(state, { requestedPermissions });
    const approved = approvePlan(result.state, result.plan.document);

    assert.deepEqual(result.state.requestedPermissions, requestedPermissions);
    assert.deepEqual(result.plan.requestedPermissions, requestedPermissions);
    assert.equal(result.event.type, "plan_approval_requested");
    assert.deepEqual(result.event.requested_permissions, requestedPermissions);
    assert.deepEqual(buildApprovedPlanHandoff(approved), {
      original_input: { request: "build" },
      approved_plan: "# Plan\n\nDo it.",
      plan_file_path: state.planFilePath,
      plan_requested_permissions: requestedPermissions
    });
  });

  it("restores pre mode and injects approved plan into workflow handoff", async () => {
    const cwd = await workspace();
    const entered = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "acceptEdits", allow: [], ask: [], deny: [] }
    });
    const approved = approvePlan(entered.state, "# Plan\nBuild it.");
    const resolved = resolvePlanApproval(approved, "continue");

    assert.equal(resolved.state.mode, "inactive");
    assert.equal(resolved.permissions.mode, "acceptEdits");
    assert.deepEqual(resolved.event, { type: "plan_approval_resolved", session_id: "session-1", decision: "continue" });
    assert.deepEqual(buildApprovedPlanHandoff(resolved.state), {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it.",
      plan_file_path: entered.state.planFilePath
    });

    let workflowRuns = 0;
    const result = await runWorkflowAfterPlanApproval(resolved.state, async (handoff) => {
      workflowRuns += 1;
      return handoff;
    });
    assert.equal(workflowRuns, 1);
    assert.deepEqual(result, {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it.",
      plan_file_path: entered.state.planFilePath
    });
  });

  it("carries approval feedback into the workflow handoff", async () => {
    const cwd = await workspace();
    const entered = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });
    const approved = approvePlan(entered.state, "# Plan\nBuild it.", "Also update the README.");

    assert.deepEqual(buildApprovedPlanHandoff(approved), {
      original_input: { request: "build" },
      approved_plan: "# Plan\nBuild it.",
      plan_file_path: entered.state.planFilePath,
      plan_approval_feedback: "Also update the README."
    });
  });

  it("keeps plan mode after rejection and stores user feedback", async () => {
    const cwd = await workspace();
    const entered = enterPlanMode({
      sessionId: "session-1",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });

    const result = resolvePlanApproval({ ...entered.state, mode: "waiting_approval" }, "stay", { answer: "split it smaller" });

    assert.equal(result.state.mode, "planning");
    assert.equal(result.permissions.mode, "plan");
    assert.deepEqual(result.event, { type: "plan_approval_resolved", session_id: "session-1", decision: "stay" });
    assert.deepEqual(result.state.feedbackMessages, [{ answer: "split it smaller" }]);
  });

  it("executes EnterPlanMode and ExitPlanMode tools", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    const entered = await tools.get("EnterPlanMode").execute({
      sessionId: "session-tool",
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    }, { cwd });
    const enteredData = entered.data as { state: PlanSessionState; permissions: { mode: string; planFilePath?: string } };

    assert.equal(enteredData.state.mode, "planning");
    assert.equal(enteredData.permissions.mode, "plan");

    await writePlan(enteredData.state.planFilePath, "# Plan\nTool path.\n");
    const exited = await tools.get("ExitPlanMode").execute({ state: enteredData.state }, { cwd });
    const exitedData = exited.data as { state: PlanSessionState; plan: { document: string } };

    assert.equal(exitedData.state.mode, "waiting_approval");
    assert.match(exitedData.plan.document, /Tool path/);
    assert.equal((exited.data as { event: { type: string } }).event.type, "plan_approval_requested");
  });

  it("hides ExitPlanMode plan input from the model schema and reads the plan file", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const { state } = enterPlanMode({
      sessionId: "session-tool-hidden-plan",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });

    const schemaProperties = tools.get("ExitPlanMode").input_schema.properties as Record<string, unknown>;
    assert.equal("allowedPrompts" in schemaProperties, true);
    assert.equal("plan" in schemaProperties, false);
    assert.equal("planFilePath" in schemaProperties, false);
    assert.equal("state" in schemaProperties, false);

    await writePlan(state.planFilePath, "# Plan\n\nUse the plan file only.\n");
    const exited = await tools.get("ExitPlanMode").execute({ state }, { cwd });
    const exitedData = exited.data as { plan: { document: string } };

    assert.equal(exitedData.plan.document, "# Plan\n\nUse the plan file only.");
  });

  it("accepts tui-code style no-argument EnterPlanMode calls", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const state: PlanSessionState = {
      mode: "planning",
      sessionId: "session-tool",
      planFilePath: getPlanFilePath("session-tool", cwd),
      prePlanMode: "default",
      originalInput: { request: "build" }
    };

    const result = await tools.get("EnterPlanMode").execute({}, { cwd, planState: state });
    const data = result.data as { state: PlanSessionState; permissions: { mode: string; planFilePath?: string } };

    assert.equal(tools.get("EnterPlanMode").input_schema.required, undefined);
    assert.match(result.output ?? "", /Entered plan mode/);
    assert.equal(data.state, state);
    assert.equal(data.permissions.mode, "plan");
    assert.equal(data.permissions.planFilePath, state.planFilePath);
  });

  it("keeps ExitPlanMode requested prompt permissions scoped to Bash", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();
    const { state } = enterPlanMode({
      sessionId: "session-tool",
      cwd,
      originalInput: { request: "build" },
      permissions: { mode: "default", allow: [], ask: [], deny: [] }
    });

    assert.deepEqual(
      ((tools.get("ExitPlanMode").input_schema.properties as { allowedPrompts: { items: { properties: { tool: { enum: string[] } } } } }).allowedPrompts.items.properties.tool.enum),
      ["Bash"]
    );

    await assert.rejects(
      () => tools.get("ExitPlanMode").execute({ state, allowedPrompts: [{ tool: "Write", prompt: "edit source" }] }, { cwd }),
      /Invalid literal value|Invalid input/
    );
  });

  it("validates AskUserQuestion input with tui-code schema constraints", async () => {
    const tools = createLocalToolRegistry();
    const valid = await tools.get("AskUserQuestion").execute({
      questions: [{
        question: "Which rollout path?",
        header: "Rollout",
        options: [
          { label: "Staged", description: "Release gradually" },
          { label: "Big bang", description: "Release at once" }
        ]
      }]
    }, { cwd: await workspace() });

    assert.deepEqual((valid.data as { questions: unknown[] }).questions, [{
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
    await assert.rejects(
      () => tools.get("AskUserQuestion").execute({ question: "Which rollout path?" }, { cwd: process.cwd() }),
      /questions/
    );
    await assert.rejects(
      () => tools.get("AskUserQuestion").execute({
        questions: [{
          question: "Which rollout path?",
          header: "Rollout",
          options: [
            { label: "Staged", description: "Release gradually" },
            { label: "Big bang", description: "Release at once" }
          ]
        }],
        unknown: true
      }, { cwd: process.cwd() }),
      /Unrecognized key|Invalid input/
    );
    assert.equal(tools.get("AskUserQuestion").input_schema.additionalProperties, false);
    assert.equal(
      ((tools.get("AskUserQuestion").input_schema.properties as { questions: { items: { properties: { multiSelect: { default?: unknown } } } } }).questions.items.properties.multiSelect.default),
      false
    );
    await assert.rejects(
      () => tools.get("AskUserQuestion").execute({
        questions: [{
          question: "Which rollout path?",
          header: "Rollout",
          options: [
            { label: "Staged", description: "Release gradually" },
            { label: "Staged", description: "Duplicate option" }
          ]
        }]
      }, { cwd: process.cwd() }),
      /Question texts must be unique|Invalid input/
    );
  });

  it("maps AskUserQuestion answers to tui-code style model-readable tool results", () => {
    const tools = createLocalToolRegistry();
    const mapped = tools.get("AskUserQuestion").mapToolResultToModelResult?.({
      data: {
        answers: { "Which rollout path?": "Big bang" },
        annotations: { "Which rollout path?": { preview: "All users", notes: "Only if rollback is instant." } }
      }
    });

    assert.equal(
      mapped,
      "User has answered your questions: \"Which rollout path?\"=\"Big bang\" selected preview:\nAll users user notes: Only if rollback is instant.. You can now continue with the user's answers in mind."
    );

    assert.equal(
      tools.get("AskUserQuestion").mapToolResultToModelResult?.({
        data: {
          action: "__finish_plan_interview__",
          feedback: "Stop asking clarifying questions and proceed to finish the plan.",
          answers: { "Which rollout path?": "Big bang" }
        }
      }),
      "Stop asking clarifying questions and proceed to finish the plan."
    );
  });

  it("exposes tui-code aligned Plan Mode tool prompts to the model", async () => {
    const tools = createLocalToolRegistry();

    assert.match(tools.get("EnterPlanMode").description, /Requests permission to enter plan mode/);
    assert.match(toolPrompt(tools.get("EnterPlanMode")), /Use this tool proactively/);
    assert.match(toolPrompt(tools.get("EnterPlanMode")), /When to Use This Tool/);
    assert.match(toolPrompt(tools.get("EnterPlanMode")), /What Happens in Plan Mode/);
    assert.match(toolPrompt(tools.get("EnterPlanMode")), /Pure research\/exploration tasks \(use the Agent tool with explore agent instead\)/);
    assert.match(toolPrompt(tools.get("EnterPlanMode")), /This tool REQUIRES user approval/);

    assert.equal(tools.get("ExitPlanMode").isConcurrencySafe?.(), true);
    assert.equal(await tools.get("ExitPlanMode").requiresUserInteraction?.({}), true);
    assert.equal(tools.get("ExitPlanMode").input_schema.required, undefined);
    assert.equal("state" in (tools.get("ExitPlanMode").input_schema.properties as Record<string, unknown>), false);
    assert.match(tools.get("ExitPlanMode").description, /exit plan mode/);
    assert.match(toolPrompt(tools.get("ExitPlanMode")), /does not accept plan text as input/);
    assert.match(toolPrompt(tools.get("ExitPlanMode")), /read from the current plan file/);
    assert.doesNotMatch(toolPrompt(tools.get("ExitPlanMode")), /complete plan in the plan parameter/);
    assert.doesNotMatch(toolPrompt(tools.get("ExitPlanMode")), /stores that plan in the plan file/);
    assert.match(toolPrompt(tools.get("ExitPlanMode")), /Do NOT use AskUserQuestion to ask "Is this plan okay\?"/);

    assert.equal(
      tools.get("AskUserQuestion").description,
      "Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices."
    );
    assert.equal(tools.get("AskUserQuestion").isConcurrencySafe?.(), true);
    assert.equal(await tools.get("AskUserQuestion").requiresUserInteraction?.({}), true);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /Users will always be able to select "Other"/);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /Use multiSelect: true/);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /Ask 1-4 questions/);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /use ExitPlanMode for plan approval/);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /Do not reference "the plan"/);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /Preview feature:/);
    assert.match(toolPrompt(tools.get("AskUserQuestion")), /preview/);
  });

});

function toolPrompt(tool: { prompt?: string | (() => string) }): string {
  return typeof tool.prompt === "function" ? tool.prompt() : tool.prompt ?? "";
}

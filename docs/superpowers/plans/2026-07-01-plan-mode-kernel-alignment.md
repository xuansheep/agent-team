# Plan Mode Kernel Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Plan Mode authority into KernelSession/QueryEngine/PlanModeController, remove model-visible `ExitPlanMode.plan`, and align permission, prompt interview, and clear-context approval behavior with tui-code.

**Architecture:** Kernel owns plan state, permissions, pending interactions, approval resolution, and approved handoff creation. TUI renders Kernel pending interactions and relays choices. Runtime and SDK paths share the same plan-file-only protocol and interaction semantics.

**Tech Stack:** TypeScript, Node.js test runner, Ink TUI, existing `Tool`/`KernelTool` abstractions, existing `.session/plans` plan file storage.

---

## File Structure

- Modify `src/tools/local/exitPlanMode.ts`: remove model-visible `plan` and `planFilePath`, keep `allowedPrompts`, read the current plan file through plan state.
- Modify `src/kernel/plan/planModeController.ts`: remove request-level plan text, add approval metadata and clear-context execution result.
- Modify `src/kernel/session.ts`: add approval metadata and execution handoff types.
- Modify `src/kernel/queryEngine.ts`: stop parsing `ExitPlanMode.plan`; route interaction tools to Kernel pending interactions.
- Modify `src/runtime/turnExecutor.ts`: keep legacy runtime aligned while Kernel migration completes.
- Modify `src/context/attachments.ts`: replace `ExitPlanMode.plan` guidance with plan-file interview flow.
- Modify `src/plans/planSession.ts`: recover only from plan-file `Write/Edit/MultiEdit`, not `ExitPlanMode.input.plan`.
- Modify `src/tui/kernelAdapter.ts` and `src/tui/TuiApp.tsx`: route plan approval choices through Kernel-shaped metadata.
- Modify `src/sdk/localSession.ts`: keep public helpers file-backed.
- Update tests under `tests/plans`, `tests/kernel`, `tests/runtime`, `tests/context`, `tests/tui`, and `tests/sdk`.

Before the first implementation commit, ask the user for a task number. If the user says there is no task number, use the commit messages shown here.

---

### Task 1: Remove `ExitPlanMode.plan` From Model-Facing Tool Schema

**Files:**
- Modify: `src/tools/local/exitPlanMode.ts`
- Modify: `tests/plans/planMode.test.ts`

- [ ] **Step 1: Write the failing schema test**

Replace the existing schema test for `ExitPlanMode` plan input with:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run build:test && node --test dist-test/tests/plans/planMode.test.js`

Expected: FAIL because `ExitPlanMode.input_schema.properties` still contains `plan`.

- [ ] **Step 3: Change the tool schema and prompt**

In `src/tools/local/exitPlanMode.ts`, use this model-facing schema:

```ts
const inputSchema = z.object({
  state: stateSchema.optional(),
  allowedPrompts: z.array(allowedPromptSchema).optional()
}).default({});
```

Make the public `input_schema.properties` contain only `allowedPrompts`. Replace the tool prompt with text that says the tool does not accept plan text and reads the current plan file.

Update `execute` so it no longer writes `parsed.plan`:

```ts
async execute(input, context) {
  const parsed = inputSchema.parse(input) as { state?: PlanSessionState; allowedPrompts?: PlanRequestedPermission[] };
  const state = parsed.state ?? context.planState;
  if (!state) return { error: "Plan Mode is not active", exit_code: 1 };
  try {
    const result = await exitPlanMode(state, { requestedPermissions: parsed.allowedPrompts });
    await context.auditSink?.({
      type: "plan_mode",
      session_id: result.event.session_id,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      action: "approval_requested",
      plan_file_path: result.plan.planFilePath
    });
    return { output: `Plan approval requested for ${result.plan.sessionId}`, data: result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), exit_code: 1 };
  }
}
```

Remove the unused `writePlan` import.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm run build:test && node --test dist-test/tests/plans/planMode.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/tools/local/exitPlanMode.ts tests/plans/planMode.test.ts
git commit -m "feat: remove model-visible ExitPlanMode plan input"
```
---

### Task 2: Remove `ExitPlanMode.input.plan` From Kernel Requests and Recovery

**Files:**
- Modify: `src/kernel/queryEngine.ts`
- Modify: `src/kernel/plan/planModeController.ts`
- Modify: `src/plans/planSession.ts`
- Modify: `tests/kernel/planModeController.test.ts`
- Modify: `tests/plans/planMode.test.ts`

- [ ] **Step 1: Write failing controller test**

Add to `tests/kernel/planModeController.test.ts`:

```ts
it("requests plan approval from the plan file without accepting request plan text", async () => {
  const cwd = await workspace();
  const controller = new PlanModeController();
  const session = createKernelSession({ id: "kernel-plan-file", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
  const planning = controller.enterPlanMode(session, { request: "build" });
  assert.ok(planning.planState);
  await writePlan(planning.planState.planFilePath, "# Kernel Plan\n\nRead from disk.\n");

  const waiting = await controller.requestPlanApproval(planning, { requestedPermissions: [{ tool: "Bash", prompt: "run tests" }] });

  assert.equal(waiting.pendingInteraction?.type, "plan_approval");
  assert.equal(waiting.pendingInteraction?.document, "# Kernel Plan\n\nRead from disk.");
  assert.deepEqual(waiting.pendingInteraction?.requestedPermissions, [{ tool: "Bash", prompt: "run tests" }]);
});
```

Import `writePlan` from `../../src/plans/planFiles.js` if needed.

- [ ] **Step 2: Write failing recovery test**

Add to `tests/plans/planMode.test.ts`:

```ts
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
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `npm run build:test && node --test dist-test/tests/kernel/planModeController.test.js dist-test/tests/plans/planMode.test.js`

Expected: FAIL because Kernel still accepts request plan text and recovery still reads `ExitPlanMode.input.plan`.

- [ ] **Step 4: Update controller request type**

In `src/kernel/plan/planModeController.ts`, replace `ExitPlanModeRequest` with:

```ts
export type ExitPlanModeRequest = {
  requestedPermissions?: { tool: string; prompt: string }[];
};
```

Remove the request plan write from `requestPlanApproval`:

```ts
async requestPlanApproval(session: KernelSession, request: ExitPlanModeRequest = {}): Promise<KernelSession> {
  if (!session.planState || session.planState.mode !== "planning") throw new Error("Plan Mode is not active");
  const exited = await exitPlanMode(session.planState, { requestedPermissions: request.requestedPermissions });
  const planHash = hashText(exited.plan.document);
  const interaction = createPlanApprovalPending({
    sessionId: session.id,
    document: exited.plan.document,
    planFilePath: exited.plan.planFilePath,
    planHash,
    empty: exited.plan.empty,
    requestedPermissions: exited.plan.requestedPermissions
  });
  const planState = withApprovalMetadata(exited.state, { approvalId: interaction.id, approvedPlanHash: planHash });
  return reduceKernelSession({ ...session, planState }, { type: "pending_interaction_set", interaction });
}
```

Remove the unused `writePlan` import.

- [ ] **Step 5: Update QueryEngine request parser**

In `src/kernel/queryEngine.ts`, replace `exitPlanRequest` with:

```ts
function exitPlanRequest(input: unknown): { requestedPermissions?: { tool: string; prompt: string }[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as { allowedPrompts?: unknown };
  return {
    requestedPermissions: Array.isArray(value.allowedPrompts) ? value.allowedPrompts.filter(isRequestedPermission) : undefined
  };
}
```

- [ ] **Step 6: Update transcript recovery**

In `src/plans/planSession.ts`, remove the branch that reads `call.name === "ExitPlanMode" && typeof input.plan === "string"`. Keep `Write`, `Edit`, and `MultiEdit` recovery unchanged.

- [ ] **Step 7: Run focused tests and verify they pass**

Run: `npm run build:test && node --test dist-test/tests/kernel/planModeController.test.js dist-test/tests/plans/planMode.test.js`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/kernel/queryEngine.ts src/kernel/plan/planModeController.ts src/plans/planSession.ts tests/kernel/planModeController.test.ts tests/plans/planMode.test.ts
git commit -m "feat: read plan approvals from plan files only"
```
---

### Task 3: Align Permission Pipeline Ordering for Interaction Tools

**Files:**
- Modify: `src/kernel/queryEngine.ts`
- Modify: `src/runtime/turnExecutor.ts`
- Modify: `tests/kernel/queryEngine.test.ts`
- Modify: `tests/runtime/turnExecutor.test.ts`

- [ ] **Step 1: Add Kernel test for interaction tools not being bypassed**

Add to `tests/kernel/queryEngine.test.ts`:

```ts
it("turns ExitPlanMode into a plan approval interaction even when pre-plan mode was bypassPermissions", async () => {
  const cwd = await workspace();
  const tools = createKernelToolRegistry(createLocalToolRegistry());
  const provider = providerWithCalls([{ id: "exit-plan", name: "ExitPlanMode", input: {} }]);
  const controller = new PlanModeController();
  const session = controller.enterPlanMode(createKernelSession({
    id: "kernel-interaction-bypass",
    cwd,
    permissions: { mode: "bypassPermissions", allow: [], ask: [], deny: [] }
  }), { request: "build" });
  assert.ok(session.planState);
  await writePlan(session.planState.planFilePath, "# Plan\n\nApprove me.\n");

  const result = await new QueryEngine().run({ session, provider, model: "test-model", tools });

  assert.equal(result.session.pendingInteraction?.type, "plan_approval");
  assert.equal(result.session.status, "waiting_plan_approval");
});
```

If helpers are missing, add:

```ts
function providerWithCalls(tool_calls: ModelToolCall[]): ModelProvider {
  return { async generate() { return { content: "tool", tool_calls }; } };
}
```

- [ ] **Step 2: Add Runtime test for Plan Mode `AskUserQuestion` interaction**

Add to `tests/runtime/turnExecutor.test.ts`:

```ts
it("returns waiting_user_input for AskUserQuestion in plan mode", async () => {
  const cwd = await workspace();
  const tools = createLocalToolRegistry();
  const entered = enterPlanMode({
    sessionId: "runtime-question-plan",
    cwd,
    originalInput: { request: "build" },
    permissions: { mode: "auto", allow: [], ask: [], deny: [] }
  });
  const provider: ModelProvider = {
    async generate() {
      return {
        content: "Need a choice.",
        tool_calls: [{
          id: "ask-1",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which rollout?", header: "Rollout", options: [
            { label: "Staged", description: "Release gradually" },
            { label: "Immediate", description: "Release now" }
          ] }] }
        }]
      };
    }
  };

  const result = await new RuntimeTurnExecutor().execute({
    sessionId: "runtime-question-plan",
    cwd,
    messages: [{ role: "user", content: "plan" }],
    model: "test-model",
    provider,
    tools,
    permissions: entered.permissions,
    planState: entered.state
  });

  assert.equal(result.status, "waiting_user_input");
});
```

- [ ] **Step 3: Run focused tests and verify current behavior**

Run: `npm run build:test && node --test dist-test/tests/kernel/queryEngine.test.js dist-test/tests/runtime/turnExecutor.test.js`

Expected: at least one new test fails if interaction tools are executed before pending interaction creation or if runtime bypasses interaction semantics.

- [ ] **Step 4: Update QueryEngine interaction ordering**

In `src/kernel/queryEngine.ts`, keep permission checks before execution. Then handle interaction tools before ordinary execution:

```ts
for (const call of calls) {
  const tool = input.tools.get(call.name);
  const context = { cwd: session.cwd, sessionId: session.id, planState: session.planState ?? undefined };
  const interaction = await tool.requiresUserInteraction(call.input, context);

  if (interaction?.type === "ask_user_question") {
    const result = await tool.execute(call.input, context);
    return { session: reduceKernelSession({ ...session, messages }, { type: "pending_interaction_set", interaction: {
      type: "ask_user_question",
      id: call.id,
      sessionId: session.id,
      toolCallId: call.id,
      questions: interaction.questions ?? questionsFromResult(result)
    } }) };
  }

  if (interaction?.type === "plan_approval") {
    return { session: await this.planMode.requestPlanApproval({ ...session, messages }, exitPlanRequest(call.input)) };
  }

  const result = await tool.execute(call.input, context);
  messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(tool.mapToolResultToModelResult(result, context)) });
}
```

- [ ] **Step 5: Update RuntimeTurnExecutor interaction ordering**

In `src/runtime/turnExecutor.ts`, add a helper:

```ts
async function firstUserInteractionTool(calls: ModelToolCall[], tools: RuntimeTurnInput["tools"]): Promise<{ call: ModelToolCall; tool: Tool } | undefined> {
  for (const call of calls) {
    const tool = tools.get(call.name);
    if (await tool.requiresUserInteraction?.(call.input)) return { call, tool };
  }
  return undefined;
}
```

Before `executeToolCalls`, use this helper to return `waiting_user_input` or `waiting_plan_approval` for the first interaction tool. Use the existing `tool.execute`, `userInputFromToolResult`, and `planApprovalFromToolResult` helpers so legacy runtime remains behavior-compatible.

- [ ] **Step 6: Run focused tests and verify they pass**

Run: `npm run build:test && node --test dist-test/tests/kernel/queryEngine.test.js dist-test/tests/runtime/turnExecutor.test.js`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/kernel/queryEngine.ts src/runtime/turnExecutor.ts tests/kernel/queryEngine.test.ts tests/runtime/turnExecutor.test.ts
git commit -m "feat: align plan interaction permission ordering"
```

---

### Task 4: Replace Plan Mode Attachments With Interview Flow Guidance

**Files:**
- Modify: `src/context/attachments.ts`
- Modify: `src/tools/local/enterPlanMode.ts`
- Modify: `src/tools/local/askUserQuestion.ts`
- Modify: `tests/context/attachments.test.ts`
- Modify: `tests/plans/planMode.test.ts`

- [ ] **Step 1: Add attachment assertions for no plan-parameter guidance**

In `tests/context/attachments.test.ts`, add assertions to full and sparse Plan Mode attachment tests:

```ts
assert.match(systemContent, /Plan mode is active/i);
assert.match(systemContent, /Current plan file:/);
assert.match(systemContent, /only file you are allowed to edit/i);
assert.match(systemContent, /AskUserQuestion/);
assert.match(systemContent, /ExitPlanMode/);
assert.doesNotMatch(systemContent, /ExitPlanMode\.plan/);
assert.doesNotMatch(systemContent, /Pass the complete plan/);
```

- [ ] **Step 2: Run attachment tests and verify they fail**

Run: `npm run build:test && node --test dist-test/tests/context/attachments.test.js`

Expected: FAIL because current attachments still mention `ExitPlanMode.plan`.

- [ ] **Step 3: Update full and sparse Plan Mode attachments**

In `src/context/attachments.ts`, replace sparse guidance with plan-file-only text:

```ts
"Plan mode still active. Stay read-only except for the current plan file.",
"Follow the iterative workflow: explore the codebase, interview the user when needed, and keep the final plan in the current plan file.",
"End turns only with AskUserQuestion for clarifications or ExitPlanMode for plan approval.",
"Call ExitPlanMode only after the current plan file contains the complete plan.",
"Never ask about plan approval via plain text or AskUserQuestion."
```

Set `planFileInfo` to:

```ts
const planFileInfo = input.draft === undefined
  ? `No plan has been saved yet. Create your plan at ${input.planFilePath} using Write.`
  : `A previous plan exists at ${input.planFilePath}. Read it and make incremental edits using Edit or MultiEdit.`;
```

Replace converge guidance with:

```ts
"When the plan is ready, call ExitPlanMode with no plan text to request approval instead of executing it."
```

- [ ] **Step 4: Update re-entry attachment**

Replace the final re-entry instruction with:

```ts
"4. Continue the plan process, edit the current plan file with the revised complete plan, then call ExitPlanMode with no plan text before requesting approval."
```

- [ ] **Step 5: Update tool prompts**

In `src/tools/local/enterPlanMode.ts`, make the final reminder say source files are forbidden and only the current plan file is editable. In `src/tools/local/askUserQuestion.ts`, keep the instruction that approval must use `ExitPlanMode`, without mentioning plan text arguments.

- [ ] **Step 6: Run focused tests and verify they pass**

Run: `npm run build:test && node --test dist-test/tests/context/attachments.test.js dist-test/tests/plans/planMode.test.js`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/context/attachments.ts src/tools/local/enterPlanMode.ts src/tools/local/askUserQuestion.ts tests/context/attachments.test.ts tests/plans/planMode.test.ts
git commit -m "feat: align plan mode interview prompts"
```
---

### Task 5: Add Kernel Approval Resolution Metadata and Clear-Context Result

**Files:**
- Modify: `src/kernel/session.ts`
- Modify: `src/kernel/plan/planModeController.ts`
- Modify: `tests/kernel/planModeController.test.ts`

- [ ] **Step 1: Add tests for keep-context and clear-context approval results**

Add to `tests/kernel/planModeController.test.ts`:

```ts
it("resolves plan approval with clear-context metadata", async () => {
  const cwd = await workspace();
  const controller = new PlanModeController();
  const session = controller.enterPlanMode(createKernelSession({
    id: "approval-clear-context",
    cwd,
    permissions: { mode: "default", allow: [], ask: [], deny: [] }
  }), { request: "build" });
  assert.ok(session.planState);
  await writePlan(session.planState.planFilePath, "# Plan\n\nClear context.\n");
  const waiting = await controller.requestPlanApproval(session);

  const resolved = controller.resolvePlanApproval(waiting, {
    decision: "continue",
    permissionMode: "auto",
    clearContext: true,
    feedback: "Run focused tests."
  });

  assert.equal(resolved.execution?.clearContext, true);
  assert.equal(resolved.execution?.permissionMode, "auto");
  assert.match(resolved.execution?.initialInput ?? "", /Implement the following plan:/);
  assert.match(resolved.execution?.initialInput ?? "", /Clear context\./);
  assert.match(resolved.execution?.initialInput ?? "", /Run focused tests\./);
});
```

- [ ] **Step 2: Run controller tests and verify they fail**

Run: `npm run build:test && node --test dist-test/tests/kernel/planModeController.test.js`

Expected: FAIL because `resolvePlanApproval` currently returns only `KernelSession` and does not accept metadata.

- [ ] **Step 3: Extend Kernel session types**

In `src/kernel/session.ts`, add:

```ts
export type PlanApprovalResolveMetadata = {
  permissionMode?: Exclude<ToolPermissionContext["mode"], "plan">;
  clearContext?: boolean;
  feedback?: unknown;
};

export type KernelExecutionHandoff = {
  clearContext: boolean;
  permissionMode: Exclude<ToolPermissionContext["mode"], "plan">;
  initialInput?: string;
  handoff: unknown;
};
```

Update the `resolve_plan_approval` intent:

```ts
| { type: "resolve_plan_approval"; decision: "continue" | "stay"; metadata?: PlanApprovalResolveMetadata }
```

- [ ] **Step 4: Update PlanModeController return shape**

In `src/kernel/plan/planModeController.ts`, add:

```ts
export type PlanApprovalResolutionResult = {
  session: KernelSession;
  execution?: KernelExecutionHandoff;
};
```

Change `resolvePlanApproval` to return `{ session, execution }`. On continue, set `permissionMode` from input metadata or resolved pre-plan mode, build the approved handoff, and set `initialInput` when `clearContext === true`:

```ts
const initialInput = input.clearContext === true
  ? freshImplementationInput(handoff.planText, session.planState.originalInput, input.feedback)
  : undefined;
```

Add helper:

```ts
function freshImplementationInput(planText: string, originalInput: unknown, feedback: unknown): string {
  const parts = [`Implement the following plan:\n\n${planText.trim()}`];
  parts.push(`\nOriginal input:\n${JSON.stringify(originalInput, null, 2)}`);
  if (typeof feedback === "string" && feedback.trim()) parts.push(`\nApproval feedback:\n${feedback.trim()}`);
  return parts.join("\n");
}
```

- [ ] **Step 5: Run controller tests and verify they pass**

Run: `npm run build:test && node --test dist-test/tests/kernel/planModeController.test.js`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/kernel/session.ts src/kernel/plan/planModeController.ts tests/kernel/planModeController.test.ts
git commit -m "feat: add kernel plan approval resolution metadata"
```

---

### Task 6: Route TUI Plan Approval Through Kernel Adapter

**Files:**
- Modify: `src/tui/kernelAdapter.ts`
- Modify: `src/tui/TuiApp.tsx`
- Create or modify: `tests/tui/kernelAdapter.test.ts`
- Modify: `tests/tui/tuiAppPlanMode.test.tsx`
- Modify: `tests/tui/tuiAppPlanReviewTranscript.test.tsx`

- [ ] **Step 1: Add adapter test**

Create `tests/tui/kernelAdapter.test.ts` if missing:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession } from "../../src/kernel/session.js";
import { createPlanApprovalPending } from "../../src/kernel/pendingInteraction.js";
import { createTuiKernelAdapter } from "../../src/tui/kernelAdapter.js";

describe("createTuiKernelAdapter", () => {
  it("maps plan approval interactions and metadata intents", () => {
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" } });
    const interaction = createPlanApprovalPending({ sessionId: "s1", document: "# Plan", planFilePath: ".session/plans/s1.md", planHash: "hash" });
    const adapter = createTuiKernelAdapter({ ...session, pendingInteraction: interaction });

    assert.equal(adapter.planReview?.document, "# Plan");
    assert.deepEqual(adapter.planApprovalIntent("continue", { permissionMode: "acceptEdits", clearContext: true, feedback: "ok" }), {
      type: "resolve_plan_approval",
      decision: "continue",
      metadata: { permissionMode: "acceptEdits", clearContext: true, feedback: "ok" }
    });
  });
});
```

- [ ] **Step 2: Run adapter test and verify it fails**

Run: `npm run build:test && node --test dist-test/tests/tui/kernelAdapter.test.js`

Expected: FAIL because adapter currently accepts only `feedback`.

- [ ] **Step 3: Update kernelAdapter**

In `src/tui/kernelAdapter.ts`, import `PlanApprovalResolveMetadata` and change `planApprovalIntent`:

```ts
planApprovalIntent: (decision: "continue" | "stay", metadata?: PlanApprovalResolveMetadata) => KernelIntent;
```

Implementation:

```ts
planApprovalIntent: (decision, metadata) => metadata === undefined
  ? { type: "resolve_plan_approval", decision }
  : { type: "resolve_plan_approval", decision, metadata }
```

- [ ] **Step 4: Route TUI approval resolution through PlanModeController**

In `src/tui/TuiApp.tsx`, replace direct `approvePlan`, `resolvePlanApproval`, and `buildApprovedPlanHandoff` usage inside approval resolution with a helper that builds a Kernel-shaped session, calls `new PlanModeController().resolvePlanApproval(...)`, stores `result.session.planState`, and starts workflow from `result.execution`.

For keep-context:

```ts
void startWorkflowInput(execution.handoff.legacyHandoff, { permissionMode: execution.permissionMode });
```

For clear-context:

```ts
void startWorkflowInput(execution.initialInput, { permissionMode: execution.permissionMode, clearContext: true });
```

Keep existing rejection log compaction and feedback UI behavior, but use Kernel result as the state source.

- [ ] **Step 5: Run focused TUI tests**

Run: `npm run build:test && node --test dist-test/tests/tui/kernelAdapter.test.js dist-test/tests/tui/tuiAppPlanMode.test.js dist-test/tests/tui/tuiAppPlanReviewTranscript.test.js`

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/tui/kernelAdapter.ts src/tui/TuiApp.tsx tests/tui/kernelAdapter.test.ts tests/tui/tuiAppPlanMode.test.tsx tests/tui/tuiAppPlanReviewTranscript.test.tsx
git commit -m "feat: route tui plan approval through kernel"
```
---

### Task 7: Update Runtime and Fake Providers to Write Plan Files Before ExitPlanMode

**Files:**
- Modify: `tests/tui/tuiAppPlanMode.test.tsx`
- Modify: `tests/runtime/turnExecutor.test.ts`
- Modify: `tests/kernel/queryEngine.test.ts`
- Modify: `tests/sdk/localSession.test.ts`

- [ ] **Step 1: Search for old `ExitPlanMode.plan` test inputs**

Run:

```bash
rg -n "ExitPlanMode.*plan|input: \{ plan|plan: \"#" tests src
```

Expected: lists old fake provider/tool-call locations that must change.

- [ ] **Step 2: Update fake providers to write the plan file first**

Replace responses like:

```ts
tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: { plan: "# Plan\n\nRemove edges node safely after approval." } }]
```

with two model turns:

```ts
if (calls === 2) {
  const planFilePath = planFilePathFromRequest(request);
  return { content: "Writing plan file.", tool_calls: [{ id: "tool-write-plan", name: "Write", input: { file_path: planFilePath, content: "# Plan\n\nRemove edges node safely after approval.\n" } }] };
}
if (calls === 3) {
  return { content: "Requesting plan approval.", tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: {} }] };
}
```

- [ ] **Step 3: Update requested permissions examples**

For examples that request allowed prompts, use:

```ts
tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: { allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] } }]
```

Ensure an earlier fake response wrote the plan file.

- [ ] **Step 4: Run old-input search again**

Run:

```bash
rg -n "input: \{ plan|ExitPlanMode\.plan|complete plan in the plan parameter|stores that plan" tests src
```

Expected: no source prompt or fake provider tells the model to pass plan text to `ExitPlanMode`.

- [ ] **Step 5: Run focused tests**

Run: `npm run build:test && node --test dist-test/tests/tui/tuiAppPlanMode.test.js dist-test/tests/runtime/turnExecutor.test.js dist-test/tests/kernel/queryEngine.test.js dist-test/tests/sdk/localSession.test.js`

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add tests/tui/tuiAppPlanMode.test.tsx tests/runtime/turnExecutor.test.ts tests/kernel/queryEngine.test.ts tests/sdk/localSession.test.ts
git commit -m "test: write plan files before exit plan mode"
```

---

### Task 8: Align SDK and Headless Plan Approval Compatibility

**Files:**
- Modify: `src/sdk/localSession.ts`
- Modify: `tests/sdk/localSession.test.ts`

- [ ] **Step 1: Add SDK compatibility test**

Add to `tests/sdk/localSession.test.ts`:

```ts
it("keeps SDK plan approval helpers file-backed", async () => {
  const cwd = await workspace();
  let approvedDocument = "";
  const session = new LocalHeadlessSession({
    cwd,
    model: "test-model",
    provider: { async generate() { return { content: "done" }; } },
    planApprovalCallback: async (plan) => {
      approvedDocument = plan.document;
      return "continue";
    }
  });

  const entered = session.enterPlanMode({ request: "build" });
  assert.equal(entered.type, "plan_mode_entered");
  await session.updatePlanDraft("# SDK Plan\n\nFile backed.\n");
  const approval = await session.requestPlanApproval();

  assert.equal(approval.decision, "continue");
  assert.equal(approvedDocument, "# SDK Plan\n\nFile backed.");
  assert.equal(session.getPlanState()?.approvedPlan, "# SDK Plan\n\nFile backed.");
});
```

- [ ] **Step 2: Run SDK tests**

Run: `npm run build:test && node --test dist-test/tests/sdk/localSession.test.js`

Expected: PASS or a clear failure showing SDK state divergence.

- [ ] **Step 3: Update LocalHeadlessSession only if the test exposes divergence**

If needed, ensure `requestPlanApproval` approves `requested.plan.document`, which is read from the plan file:

```ts
const approvedState = decision === "continue" ? { ...this.planState, approvedPlan: requested.plan.document } : this.planState;
```

Do not add any model-tool plan parameter path.

- [ ] **Step 4: Run SDK tests again**

Run: `npm run build:test && node --test dist-test/tests/sdk/localSession.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add src/sdk/localSession.ts tests/sdk/localSession.test.ts
git commit -m "feat: keep sdk plan approvals file backed"
```

---

### Task 9: Final Integration and Regression Sweep

**Files:**
- Modify only files needed to fix failures found by this task.

- [ ] **Step 1: Search for removed protocol remnants**

Run:

```bash
rg -n "ExitPlanMode\.plan|Pass the complete plan|complete plan in the plan parameter|stores that plan|input: \{ plan" src tests docs/superpowers/plans docs/superpowers/specs
```

Expected: only documentation describing removed behavior remains. No source prompt, tool schema, or fake provider should instruct the model to pass plan text to `ExitPlanMode`.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Fix compile or test failures in the smallest relevant file set**

If TypeScript reports a mismatch around `resolvePlanApproval`, update call sites to use:

```ts
const result = controller.resolvePlanApproval(session, { decision: "continue", permissionMode: "default", clearContext: false });
const nextSession = result.session;
```

If tests fail because `ExitPlanMode` was called without a written plan where a plan is expected, write the plan file first:

```ts
tool_calls: [{ id: "write-plan", name: "Write", input: { file_path: planFilePath, content: "# Plan\n\nTest plan.\n" } }]
```

Then call:

```ts
tool_calls: [{ id: "exit-plan", name: "ExitPlanMode", input: {} }]
```

- [ ] **Step 4: Re-run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit integration fixes**

```bash
git add src tests
git commit -m "test: align plan mode regression coverage"
```

- [ ] **Step 6: Report final status**

Run: `git status --short`

Expected: only unrelated pre-existing untracked files remain, such as `agent-team.yaml`.

Report:

```text
Plan Mode kernel alignment implemented.
Tests: npm test passed.
Remaining untracked files: agent-team.yaml (pre-existing, untouched).
```

## Self-Review Notes

Spec coverage:
- Kernel-owned Plan Mode: Tasks 2, 5, and 6.
- Plan-file-only `ExitPlanMode`: Tasks 1, 2, and 7.
- Permission pipeline ordering: Task 3.
- Interview prompt flow: Task 4.
- Clear-context approval: Tasks 5 and 6.
- Recovery without `ExitPlanMode.input.plan`: Task 2.
- SDK compatibility: Task 8.
- Full regression: Task 9.

Type consistency:
- `PlanApprovalResolveMetadata` belongs in `src/kernel/session.ts`.
- `PlanApprovalResolutionResult` belongs in `src/kernel/plan/planModeController.ts`.
- `KernelExecutionHandoff` belongs in `src/kernel/session.ts` and is consumed by TUI approval handling.
- `ExitPlanModeRequest` contains `requestedPermissions` only.

Verification:
- Each task has a focused test command.
- Final verification is `npm test`.
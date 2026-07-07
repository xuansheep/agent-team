# Permission Mode Tightening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the permission model with only `default`, `fullAccess`, and `plan`, remove legacy `acceptEdits`/`auto`/`dontAsk` handling, and rename `bypassPermissions` to `fullAccess` everywhere.

**Architecture:** Start at the shared `PermissionMode` type and Zod schemas, then simplify the permission checker and propagate `fullAccess` through Kernel, Plan Mode, WorkflowEngine, SDK, and TUI. This is a hard cut: old values fail validation and are not migrated.

**Tech Stack:** TypeScript, Zod, React Ink TUI, Node test runner via `npm test`.

---

## File Structure

- Modify `src/permissions/PermissionMode.ts`: define the only supported runtime modes.
- Modify `src/permissions/checkToolPermission.ts`: remove legacy permission branches and keep `default/fullAccess/plan` behavior.
- Modify `src/config/schema.ts`, `src/settings/types.ts`, `src/sdk/schemas.ts`: tighten public and internal input schemas.
- Modify `src/tools/local/enterPlanMode.ts` and `src/tools/local/exitPlanMode.ts`: update tool-side plan mode schemas.
- Modify `src/kernel/session.ts`, `src/kernel/appState.ts`, `src/kernel/plan/planModeController.ts`, `src/kernel/queryEngine.ts`: rename full access state and restore behavior.
- Modify `src/workflow/state.ts`, `src/workflow/engine.ts`, `src/harness/context.ts`, `src/model/modelRouting.ts`: use the new workflow run modes and remove Auto Mode coupling.
- Modify `src/context/attachments.ts`: delete Auto Mode attachment builders and related logic if no non-permission use remains.
- Modify `src/tui/TuiApp.tsx`, `src/tui/state.ts`, `src/tui/eventAdapter.ts`, `src/tui/components/StatusLine.tsx`, `src/tui/components/InteractionArea.tsx`, `src/tui/components/PromptInput/PromptInput.tsx`: replace `bypassPermissions` with `fullAccess` and remove legacy UI paths.
- Modify focused tests under `tests/permissions`, `tests/config`, `tests/settings`, `tests/sdk`, `tests/kernel`, `tests/workflow`, `tests/context`, and `tests/tui`.
- Modify docs/examples only where they name removed permission values: `agent-team.example.yaml`, `README.md`, and existing docs under `docs/superpowers` if they describe current behavior.

## Task 1: Tighten Shared Types and Schemas

**Files:**
- Modify: `src/permissions/PermissionMode.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/settings/types.ts`
- Modify: `src/sdk/schemas.ts`
- Modify: `src/tools/local/enterPlanMode.ts`
- Modify: `src/tools/local/exitPlanMode.ts`
- Test: `tests/workflow/planModeSeparation.test.ts`
- Test: `tests/config/loadConfig.test.ts`
- Test: `tests/settings/settings.test.ts`
- Test: `tests/sdk/schemas.test.ts`

- [ ] **Step 1: Update schema tests to assert new accepted values and old-value rejection**

In `tests/workflow/planModeSeparation.test.ts`, update the plan-permission rejection test to keep rejecting `plan`, and add old-value rejection for workflow node `permission_mode`.

```ts
it("rejects removed workflow node permission modes", () => {
  for (const permission_mode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
    assert.throws(
      () => configSchema.parse(configWithNodePermissionMode(permission_mode)),
      /Invalid enum value/
    );
  }
});

function configWithNodePermissionMode(permission_mode: string) {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode }], edges: [] } }
  };
}
```

In `tests/settings/settings.test.ts`, replace old default mode assertions with:

```ts
it("accepts only current settings permission defaults", () => {
  assert.equal(settingsSchema.parse({ permissions: { defaultMode: "default" } }).permissions?.defaultMode, "default");
  assert.equal(settingsSchema.parse({ permissions: { defaultMode: "fullAccess" } }).permissions?.defaultMode, "fullAccess");
  assert.equal(settingsSchema.parse({ permissions: { defaultMode: "plan" } }).permissions?.defaultMode, "plan");
  for (const defaultMode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
    assert.throws(() => settingsSchema.parse({ permissions: { defaultMode } }), /Invalid enum value/);
  }
});
```

In `tests/sdk/schemas.test.ts`, assert the SDK accepts only the three values.

```ts
it("accepts only current SDK permission modes", () => {
  assert.equal(sdkQuerySchema.parse(baseQuery({ permissionMode: "default" })).permissionMode, "default");
  assert.equal(sdkQuerySchema.parse(baseQuery({ permissionMode: "fullAccess" })).permissionMode, "fullAccess");
  assert.equal(sdkQuerySchema.parse(baseQuery({ permissionMode: "plan" })).permissionMode, "plan");
  for (const permissionMode of ["acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
    assert.throws(() => sdkQuerySchema.parse(baseQuery({ permissionMode })), /Invalid enum value/);
  }
});

function baseQuery(patch: Record<string, unknown> = {}) {
  return { model: "test-model", messages: [], cwd: process.cwd(), ...patch };
}
```

- [ ] **Step 2: Run schema tests and confirm failures**

Run:

```bash
npm test -- tests/workflow/planModeSeparation.test.ts tests/settings/settings.test.ts tests/sdk/schemas.test.ts
```

Expected: FAIL with old enum values still accepted or `fullAccess` rejected.

- [ ] **Step 3: Update shared type and public schemas**

Change `src/permissions/PermissionMode.ts` to:

```ts
export type PermissionMode = "default" | "fullAccess" | "plan";
```

In `src/config/schema.ts`, change node `permission_mode` to:

```ts
permission_mode: z.enum(["default", "fullAccess"]).default("default"),
```

In `src/settings/types.ts`, change settings schema to:

```ts
export const settingsPermissionModeSchema = z.enum(["default", "fullAccess", "plan"]);
```

In `src/sdk/schemas.ts`, change query permission schema to:

```ts
permissionMode: z.enum(["default", "fullAccess", "plan"]).default("default")
```

- [ ] **Step 4: Update Plan Mode local tool schemas**

In `src/tools/local/enterPlanMode.ts`, replace both `mode` and `prePlanMode` enums with:

```ts
z.enum(["default", "fullAccess", "plan"])
```

In `src/tools/local/exitPlanMode.ts`, replace `prePlanMode` enum with:

```ts
prePlanMode: z.enum(["default", "fullAccess", "plan"]),
```

- [ ] **Step 5: Run schema tests again**

Run:

```bash
npm test -- tests/workflow/planModeSeparation.test.ts tests/settings/settings.test.ts tests/sdk/schemas.test.ts tests/config/loadConfig.test.ts
```

Expected: PASS after downstream compile errors are addressed in later tasks. If TypeScript fails on `bypassPermissions` references, proceed to Task 2.

- [ ] **Step 6: Commit schema tightening**

```bash
git add src/permissions/PermissionMode.ts src/config/schema.ts src/settings/types.ts src/sdk/schemas.ts src/tools/local/enterPlanMode.ts src/tools/local/exitPlanMode.ts tests/workflow/planModeSeparation.test.ts tests/settings/settings.test.ts tests/sdk/schemas.test.ts tests/config/loadConfig.test.ts
git commit -m "feat:收紧权限模式枚举"
```

## Task 2: Simplify Permission Checker

**Files:**
- Modify: `src/permissions/checkToolPermission.ts`
- Test: `tests/permissions/permissionMode.test.ts`
- Test: `tests/kernel/permissionKernel.test.ts`

- [ ] **Step 1: Rewrite permission checker tests around three modes**

In `tests/permissions/permissionMode.test.ts`, delete tests for `acceptEdits`, `auto`, and `dontAsk`. Replace the bypass test with:

```ts
it("allows tools in fullAccess mode but still honors deny rules", async () => {
  const cwd = await workspace();

  assert.equal((await checkToolPermission(readTool, { file_path: ".env" }, {
    mode: "fullAccess",
    allow: [],
    ask: [],
    deny: [],
    cwd
  })).decision, "allow");

  assert.equal((await checkToolPermission(bashTool, { command: "git reset --hard" }, {
    mode: "fullAccess",
    allow: [],
    ask: [],
    deny: ["Bash(git reset*)"],
    cwd
  })).decision, "deny");
});
```

Keep existing default and Plan Mode tests, but replace any `bypassPermissions` fixture with `fullAccess`.

- [ ] **Step 2: Run permission tests and confirm failures**

Run:

```bash
npm test -- tests/permissions/permissionMode.test.ts tests/kernel/permissionKernel.test.ts
```

Expected: FAIL while `checkToolPermission` still references removed modes.

- [ ] **Step 3: Remove legacy branches from `checkToolPermission`**

In `src/permissions/checkToolPermission.ts`, keep the deny check and Plan Mode logic, then use only `fullAccess` and default behavior:

```ts
  if (context.mode === "plan") return checkPlanModePermission(tool, input, context);
  if (context.mode === "fullAccess") return { decision: "allow" };

  return decidePermission(tool.name, specifier, context);
```

Delete these functions entirely:

```ts
checkAcceptEditsPermission
checkAutoPermission
checkDontAskPermission
```

Keep `isEditTool` only if still used by Plan Mode write checks. If it becomes unused, delete it too.

- [ ] **Step 4: Run permission tests again**

Run:

```bash
npm test -- tests/permissions/permissionMode.test.ts tests/kernel/permissionKernel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit permission checker cleanup**

```bash
git add src/permissions/checkToolPermission.ts tests/permissions/permissionMode.test.ts tests/kernel/permissionKernel.test.ts
git commit -m "refactor:简化权限检查模式"
```

## Task 3: Rename Kernel, Plan, and Workflow Full Access State

**Files:**
- Modify: `src/kernel/session.ts`
- Modify: `src/kernel/appState.ts`
- Modify: `src/kernel/plan/planModeController.ts`
- Modify: `src/kernel/queryEngine.ts`
- Modify: `src/plans/planSession.ts`
- Modify: `src/workflow/state.ts`
- Modify: `src/workflow/engine.ts`
- Modify: `src/model/modelRouting.ts`
- Test: `tests/kernel/session.test.ts`
- Test: `tests/kernel/planModeController.test.ts`
- Test: `tests/kernel/queryEngine.test.ts`
- Test: `tests/workflow/engine.test.ts`

- [ ] **Step 1: Update Kernel and workflow tests to use `fullAccess`**

In `tests/kernel/session.test.ts`, replace expected `bypassPermissions` values with `fullAccess`:

```ts
const next = reduceKernelSession(session, {
  type: "default_execution_mode_set",
  mode: "fullAccess"
});

assert.equal(next.defaultExecutionMode, "fullAccess");
assert.equal(next.toolPermissionContext.mode, "fullAccess");
```

In `tests/kernel/planModeController.test.ts`, replace the full-access restore test with:

```ts
it("continues with the current fullAccess default execution mode after changing it in Plan Mode", async () => {
  const cwd = await workspace();
  const controller = new PlanModeController();
  const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
  const planning = controller.enterPlanMode(session, { request: "build" });
  const planningWithFullAccessDefault = reduceKernelSession(planning, {
    type: "default_execution_mode_set",
    mode: "fullAccess"
  });
  await writePlan(planningWithFullAccessDefault.planState!.planFilePath, "# Plan\n\nShip safely.");
  const waiting = await controller.requestPlanApproval(planningWithFullAccessDefault);

  const resolved = await controller.resolvePlanApproval(waiting, { decision: "continue" });

  assert.equal(resolved.session.defaultExecutionMode, "fullAccess");
  assert.equal(resolved.session.toolPermissionContext.mode, "fullAccess");
  assert.equal(resolved.execution?.permissionMode, "fullAccess");
});
```

In `tests/workflow/engine.test.ts`, replace the run-level override test with `permissionMode: "fullAccess"` and `run_permission_mode === "fullAccess"`.

- [ ] **Step 2: Run focused Kernel/workflow tests and confirm failures**

Run:

```bash
npm test -- tests/kernel/session.test.ts tests/kernel/planModeController.test.ts tests/kernel/queryEngine.test.ts tests/workflow/engine.test.ts
```

Expected: FAIL while production code still uses `bypassPermissions`, `acceptEdits`, or `auto`.

- [ ] **Step 3: Update Kernel full-access naming**

In `src/kernel/session.ts`, update the type and helper:

```ts
export type DefaultExecutionMode = Extract<ToolPermissionContext["mode"], "default" | "fullAccess">;

function defaultExecutionModeFrom(mode: ToolPermissionContext["mode"]): DefaultExecutionMode {
  return mode === "fullAccess" ? "fullAccess" : "default";
}
```

Ensure all `default_execution_mode_set` call sites use `fullAccess`.

- [ ] **Step 4: Update Plan Mode restore logic**

In `src/kernel/plan/planModeController.ts`, update full-access restore helper:

```ts
function defaultExecutionModeFrom(mode: KernelSession["toolPermissionContext"]["mode"]): KernelSession["defaultExecutionMode"] {
  return mode === "fullAccess" ? "fullAccess" : "default";
}
```

Remove test and production references to `acceptEdits` and `auto` in Plan approval metadata unless they are replaced by `default`.

- [ ] **Step 5: Update workflow run mode expectations**

In `src/workflow/engine.ts`, keep:

```ts
export type WorkflowRunPermissionMode = Exclude<PermissionMode, "plan">;
```

After Task 1 this type is only `default | fullAccess`. Replace literal `bypassPermissions` references in code and tests with `fullAccess`.

- [ ] **Step 6: Update model routing if it references removed modes**

In `src/model/modelRouting.ts`, keep Plan Mode model selection only:

```ts
const selected = input.permissionMode === "plan" && input.planModel
  ? input.planModel
  : input.node?.model ?? input.role?.default_model ?? input.provider.default_model;
```

No special handling for `auto`, `acceptEdits`, or `dontAsk` should remain.

- [ ] **Step 7: Run focused Kernel/workflow tests again**

Run:

```bash
npm test -- tests/kernel/session.test.ts tests/kernel/planModeController.test.ts tests/kernel/queryEngine.test.ts tests/workflow/engine.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Kernel/workflow rename**

```bash
git add src/kernel/session.ts src/kernel/appState.ts src/kernel/plan/planModeController.ts src/kernel/queryEngine.ts src/plans/planSession.ts src/workflow/state.ts src/workflow/engine.ts src/model/modelRouting.ts tests/kernel/session.test.ts tests/kernel/planModeController.test.ts tests/kernel/queryEngine.test.ts tests/workflow/engine.test.ts
git commit -m "refactor:重命名fullAccess权限状态"
```

## Task 4: Remove Auto Mode Runtime Attachments

**Files:**
- Modify: `src/context/attachments.ts`
- Modify: `src/harness/context.ts`
- Modify: `src/runtime/turnExecutor.ts`
- Test: `tests/context/attachments.test.ts`
- Test: `tests/runtime/turnExecutor.test.ts`

- [ ] **Step 1: Remove or rewrite Auto Mode attachment tests**

In `tests/context/attachments.test.ts`, delete tests whose only purpose is `auto_mode`, `auto_mode_reminder`, or `auto_mode_exit`. Keep Plan Mode tests and update any pre-plan mode fixtures from `auto` to `default` or `fullAccess`.

For workflow node messages, replace the old auto assertion with a fullAccess no-auto assertion:

```ts
it("does not inject Auto Mode instructions for fullAccess workflow node messages", async () => {
  const messages = await buildNodeMessages(
    { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
    "Build safely.",
    { request: "x" },
    { permissionMode: "fullAccess" }
  );

  const system = messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
  assert.doesNotMatch(system, /ATTACHMENT auto_mode/);
});
```

- [ ] **Step 2: Run context tests and confirm failures**

Run:

```bash
npm test -- tests/context/attachments.test.ts tests/runtime/turnExecutor.test.ts
```

Expected: FAIL until Auto Mode attachment code is removed.

- [ ] **Step 3: Remove Auto Mode attachment types and builders**

In `src/context/attachments.ts`, remove these attachment types if present:

```ts
auto_mode
auto_mode_reminder
auto_mode_exit
```

Delete `buildAutoModeAttachment` and related reminder/exit logic. Keep Plan Mode attachment logic unchanged.

- [ ] **Step 4: Remove Auto Mode attachment callers**

In `src/harness/context.ts`, delete:

```ts
if (input.permissionMode === "auto") attachments.push(buildAutoModeAttachment());
```

In runtime or query message builders, delete logic that checks `prePlanMode === "auto"` or `planUseAutoMode` for Auto Mode attachment injection. If `planUseAutoMode` becomes unused after this removal, remove it from `ToolPermissionContext`, `PlanSessionState`, and related persistence tests in a later cleanup step in this same task.

- [ ] **Step 5: Run context/runtime tests again**

Run:

```bash
npm test -- tests/context/attachments.test.ts tests/runtime/turnExecutor.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Auto Mode removal**

```bash
git add src/context/attachments.ts src/harness/context.ts src/runtime/turnExecutor.ts tests/context/attachments.test.ts tests/runtime/turnExecutor.test.ts
git commit -m "refactor:移除auto权限模式附件"
```

## Task 5: Update TUI Permission UX

**Files:**
- Modify: `src/tui/TuiApp.tsx`
- Modify: `src/tui/state.ts`
- Modify: `src/tui/eventAdapter.ts`
- Modify: `src/tui/components/StatusLine.tsx`
- Modify: `src/tui/components/InteractionArea.tsx`
- Modify: `src/tui/components/PromptInput/PromptInput.tsx`
- Test: `tests/tui/tuiAppPlanMode.test.tsx`
- Test: `tests/tui/components.test.tsx`
- Test: `tests/tui/eventAdapter.test.ts`
- Test: `tests/tui/kernelIntegration.test.tsx`

- [ ] **Step 1: Update TUI tests to use `fullAccess` and remove legacy options**

In `tests/tui/tuiAppPlanMode.test.tsx`, replace settings fixtures:

```tsx
settings={{ permissions: { defaultMode: "fullAccess" } }}
```

Replace expected workflow start options:

```ts
assert.deepEqual(options[0], { permissionMode: "fullAccess" });
```

Delete or rewrite tests that expect these labels:

```txt
Auto Mode
Accept Edits
Don't Ask
Bypass Permissions
Yes, auto-accept edits
Yes, clear context and use auto mode
```

Add or keep a focused `/permissions` test:

```ts
it("uses fullAccess from /permissions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-full-access-"));
  const options: unknown[] = [];
  const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
  const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

  await sendTuiLine(output, "/permissions");
  await waitForFrame(output, /Full access/);
  await sendKey(output, { name: "down" });
  await sendKey(output, { name: "return" });
  await waitForFrame(output, /Permission mode: Full access|full access/i);
  await sendTuiLine(output, "build it");
  await settleTuiWork();

  assert.deepEqual(options[0], { permissionMode: "fullAccess" });
});
```

- [ ] **Step 2: Run TUI tests and confirm failures**

Run:

```bash
npm test -- tests/tui/tuiAppPlanMode.test.tsx tests/tui/components.test.tsx tests/tui/eventAdapter.test.ts tests/tui/kernelIntegration.test.tsx
```

Expected: FAIL while UI still emits old values or old labels.

- [ ] **Step 3: Update TUI state types and initial state**

In `src/tui/state.ts`, change default execution type:

```ts
export type TuiDefaultExecutionMode = Extract<PermissionMode, "default" | "fullAccess">;
```

In `src/tui/eventAdapter.ts`, update helper:

```ts
function defaultExecutionModeFrom(mode: PermissionMode | undefined): TuiState["defaultExecutionMode"] {
  return mode === "fullAccess" ? "fullAccess" : "default";
}
```

- [ ] **Step 4: Update `/permissions` and mode labels in `TuiApp.tsx`**

Replace all `bypassPermissions` literals with `fullAccess`.

Use this label helper:

```ts
function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "fullAccess") return "Full access";
  if (mode === "plan") return "Plan Mode";
  return "Default";
}
```

Make `/permissions` choices emit `fullAccess`:

```ts
const options = [
  { label: "Default", value: "default" },
  { label: "Full access", value: "fullAccess" }
];
```

- [ ] **Step 5: Remove Plan approval modes for auto and accept edits**

In `TuiApp.tsx`, simplify `planApprovalPermissionMode` to return only `default` or `fullAccess`:

```ts
function planApprovalPermissionMode(value: string, isFullAccessModeAvailable = false): PermissionMode {
  if (value === "yes-full-access") return "fullAccess";
  if (value === "yes-default-keep-context" && isFullAccessModeAvailable) return "fullAccess";
  return "default";
}
```

Update plan approval options to use labels such as:

```txt
Yes, continue
Yes, clear context
Yes, and use full access
Yes, clear context and use full access
No, keep planning
```

Do not leave labels containing `auto`, `auto-accept`, `accept edits`, or `bypass`.

- [ ] **Step 6: Update status line labels**

In `src/tui/components/StatusLine.tsx`, update label helpers:

```ts
function effectiveModeLabel(mode: TuiMode, permissionMode: PermissionMode): string {
  if (mode === "waiting_plan_approval") return "Plan Review";
  if (mode === "planning" || (mode === "input" && permissionMode === "plan")) return "Plan";
  if (mode === "input" && permissionMode === "fullAccess") return "Full access";
  if (mode === "input") return "Default";
  return mode.replaceAll("_", " ");
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "fullAccess") return "full access";
  if (mode === "plan") return "plan";
  return "default";
}
```

- [ ] **Step 7: Run focused TUI tests again**

Run:

```bash
npm test -- tests/tui/tuiAppPlanMode.test.tsx tests/tui/components.test.tsx tests/tui/eventAdapter.test.ts tests/tui/kernelIntegration.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit TUI update**

```bash
git add src/tui/TuiApp.tsx src/tui/state.ts src/tui/eventAdapter.ts src/tui/components/StatusLine.tsx src/tui/components/InteractionArea.tsx src/tui/components/PromptInput/PromptInput.tsx tests/tui/tuiAppPlanMode.test.tsx tests/tui/components.test.tsx tests/tui/eventAdapter.test.ts tests/tui/kernelIntegration.test.tsx
git commit -m "refactor:更新tui fullAccess权限模式"
```

## Task 6: Update Docs, Examples, and Legacy References

**Files:**
- Modify: `agent-team.example.yaml`
- Modify: `README.md`
- Modify: `docs/tui-code-replication-scope.md`
- Modify: `docs/superpowers/specs/2026-07-07-mode-permission-source-alignment-design.md`
- Modify: `docs/superpowers/plans/2026-07-07-mode-permission-source-alignment.md`
- Test: no dedicated tests

- [ ] **Step 1: Search for legacy permission values**

Run:

```bash
rg -n 'acceptEdits|dontAsk|bypassPermissions|permissionMode: "auto"|permission_mode: "auto"|defaultMode: "auto"|auto_mode|Auto Mode|Bypass Permissions|Accept Edits|Don.t Ask' src tests docs README.md agent-team.example.yaml
```

Expected: matches remain before cleanup.

- [ ] **Step 2: Update examples and docs that describe current behavior**

Replace current behavior references:

```txt
bypassPermissions -> fullAccess
Bypass Permissions -> Full access
```

Remove references that instruct users to use `acceptEdits`, `auto`, or `dontAsk` as permission modes.

In older design docs, either update the text to say the earlier design was superseded by `2026-07-07-permission-mode-tightening-design.md`, or replace internal values with `fullAccess` where the doc is still used as current reference.

- [ ] **Step 3: Search again and classify remaining matches**

Run:

```bash
rg -n 'acceptEdits|dontAsk|bypassPermissions|auto_mode|Auto Mode|Bypass Permissions|Accept Edits|Don.t Ask' src tests docs README.md agent-team.example.yaml
```

Expected: no matches in production code. Any remaining matches must be in historical docs that explicitly say they are superseded, or tests asserting old values are rejected.

- [ ] **Step 4: Commit docs cleanup**

```bash
git add agent-team.example.yaml README.md docs/tui-code-replication-scope.md docs/superpowers/specs/2026-07-07-mode-permission-source-alignment-design.md docs/superpowers/plans/2026-07-07-mode-permission-source-alignment.md
git commit -m "docs:更新权限模式命名"
```

Skip paths that did not change.

## Task 7: Final Regression Sweep

**Files:**
- No planned source files beyond previous tasks.

- [ ] **Step 1: Run focused permission and schema suite**

Run:

```bash
npm test -- tests/permissions/permissionMode.test.ts tests/workflow/planModeSeparation.test.ts tests/config/loadConfig.test.ts tests/settings/settings.test.ts tests/sdk/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused Kernel/workflow suite**

Run:

```bash
npm test -- tests/kernel/session.test.ts tests/kernel/planModeController.test.ts tests/kernel/queryEngine.test.ts tests/kernel/permissionKernel.test.ts tests/workflow/engine.test.ts tests/workflow/session.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run focused TUI/context suite**

Run:

```bash
npm test -- tests/context/attachments.test.ts tests/runtime/turnExecutor.test.ts tests/tui/tuiAppPlanMode.test.tsx tests/tui/components.test.tsx tests/tui/eventAdapter.test.ts tests/tui/kernelIntegration.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run full test suite if focused tests pass**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Verify no production legacy permission modes remain**

Run:

```bash
rg -n 'acceptEdits|dontAsk|bypassPermissions|auto_mode|Auto Mode|Bypass Permissions|Accept Edits|Don.t Ask' src README.md agent-team.example.yaml
```

Expected: no output.

Run:

```bash
rg -n '"auto"|\bauto\b' src tests docs README.md agent-team.example.yaml
```

Expected: remaining matches are unrelated to permission mode, such as provider `tool_choice: auto`, layout values, or historical docs explicitly marked as superseded.

- [ ] **Step 6: Inspect Git status**

Run:

```bash
git status --short
```

Expected: only intended files changed. Do not stage unrelated `.agents/` or local `agent-team.yaml` unless the user explicitly asks.

- [ ] **Step 7: Commit final test/doc adjustments if any remain**

If Step 6 shows only intended cleanup files not already committed:

```bash
git add <intended-files>
git commit -m "test:覆盖权限模式收紧回归"
```

Skip this commit if there are no remaining intended changes.

## Self-Review

- Spec coverage: Tasks 1-7 cover type/schema tightening, hard-cut legacy rejection, `fullAccess` rename, permission checker simplification, Plan Mode protections, workflow run state, TUI `/permissions`, Auto Mode removal, docs, and regression searches.
- 占位内容检查通过：没有未完成标记或未具体化的任务步骤。
- Type consistency: the plan consistently uses `fullAccess` for full access, `default | fullAccess` for execution/default modes, and `default | fullAccess | plan` for full runtime permission mode.

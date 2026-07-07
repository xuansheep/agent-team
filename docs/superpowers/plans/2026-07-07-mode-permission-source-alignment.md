# Mode Permission Source Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kernel/AppState the single source of truth for mode switching, with `/permissions` selecting `default` or `full access` and Shift+Tab toggling between the selected default execution mode and Plan Mode.

**Architecture:** Add `defaultExecutionMode` to Kernel session state and expose it through AppState. TUI sends explicit Kernel intents for default-mode changes and mode cycling, while `inputPermissionMode` becomes display-only during migration. Plan Mode entry and approval restore use Kernel-owned `defaultExecutionMode` rather than TUI-local state.

**Tech Stack:** TypeScript, React Ink TUI, Node test runner, existing Kernel/PlanModeController/WorkflowEngine abstractions.

---

## File Structure

- Modify `src/kernel/session.ts`: define `DefaultExecutionMode`, store it in `KernelSession`, add reducer action for changing it and syncing effective permissions.
- Modify `src/kernel/appState.ts`: project `defaultExecutionMode` and effective `permissionMode` together.
- Modify `src/kernel/plan/planModeController.ts`: enter Plan Mode using the selected default execution mode.
- Modify `src/tui/state.ts`: keep `inputPermissionMode` only as legacy display state during migration.
- Modify `src/tui/eventAdapter.ts`: reset state from projected permission state rather than treating `inputPermissionMode` as authority.
- Modify `src/tui/TuiApp.tsx`: replace `nextInputPermissionMode`, `/permissions`, and Plan cycling with Kernel-derived transitions.
- Modify `src/tui/components/StatusLine.tsx`: display `full access` for `bypassPermissions`.
- Modify tests in `tests/kernel/session.test.ts`, `tests/kernel/planModeController.test.ts`, `tests/tui/tuiAppPlanMode.test.tsx`, and `tests/tui/components.test.tsx`.

## Task 1: Kernel Default Execution Mode

**Files:**
- Modify: `src/kernel/session.ts`
- Modify: `src/kernel/appState.ts`
- Test: `tests/kernel/session.test.ts`

- [ ] **Step 1: Write failing Kernel session tests**

Add these tests to `tests/kernel/session.test.ts`.

```ts
it("projects default execution mode separately from effective permission mode", () => {
  const session = createKernelSession({
    id: "s1",
    cwd: process.cwd(),
    permissions: { mode: "default", allow: [], ask: [], deny: [] }
  });

  assert.equal(session.defaultExecutionMode, "default");
  assert.equal(projectKernelAppState(session).defaultExecutionMode, "default");
  assert.equal(projectKernelAppState(session).permissionMode, "default");
});

it("sets default execution mode and effective mode outside Plan Mode", () => {
  const session = createKernelSession({
    id: "s1",
    cwd: process.cwd(),
    permissions: { mode: "default", allow: [], ask: [], deny: [] }
  });

  const next = reduceKernelSession(session, {
    type: "default_execution_mode_set",
    mode: "bypassPermissions"
  });

  assert.equal(next.defaultExecutionMode, "bypassPermissions");
  assert.equal(next.toolPermissionContext.mode, "bypassPermissions");
});

it("changes default execution mode during Plan Mode without leaving Plan Mode", () => {
  const session = createKernelSession({
    id: "s1",
    cwd: process.cwd(),
    permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" }
  });

  const next = reduceKernelSession(session, {
    type: "default_execution_mode_set",
    mode: "bypassPermissions"
  });

  assert.equal(next.defaultExecutionMode, "bypassPermissions");
  assert.equal(next.toolPermissionContext.mode, "plan");
});
```

- [ ] **Step 2: Run focused Kernel session tests and confirm failure**

Run: `npm test -- tests/kernel/session.test.ts`

Expected: FAIL because `defaultExecutionMode` and `default_execution_mode_set` do not exist.

- [ ] **Step 3: Implement Kernel session state**

In `src/kernel/session.ts`, add the type and field.

```ts
export type DefaultExecutionMode = Extract<ToolPermissionContext["mode"], "default" | "bypassPermissions">;

export type KernelSession = {
  id: string;
  cwd: string;
  status: KernelStatus;
  messages: ModelMessage[];
  toolPermissionContext: ToolPermissionContext;
  defaultExecutionMode: DefaultExecutionMode;
  planState: PlanSessionState | null;
  workflowBinding: WorkflowBinding | null;
  pendingInteraction: PendingInteraction | null;
};
```

Add `defaultExecutionMode` in `createKernelSession`.

```ts
defaultExecutionMode: defaultExecutionModeFrom(input.permissions.mode),
```

Add reducer action and helpers.

```ts
export type KernelAction =
  | { type: "status_set"; status: KernelStatus }
  | { type: "messages_set"; messages: ModelMessage[] }
  | { type: "permissions_set"; permissions: ToolPermissionContext }
  | { type: "default_execution_mode_set"; mode: DefaultExecutionMode }
  | { type: "plan_state_set"; planState: PlanSessionState | null }
  | { type: "workflow_binding_set"; workflowBinding: WorkflowBinding | null }
  | { type: "pending_interaction_set"; interaction: PendingInteraction }
  | { type: "pending_interaction_cleared"; status?: KernelStatus }
  | { type: "intent_applied"; intent: KernelIntent };

function defaultExecutionModeFrom(mode: ToolPermissionContext["mode"]): DefaultExecutionMode {
  return mode === "bypassPermissions" ? "bypassPermissions" : "default";
}

function applyDefaultExecutionMode(session: KernelSession, mode: DefaultExecutionMode): KernelSession {
  if (session.toolPermissionContext.mode === "plan") {
    return { ...session, defaultExecutionMode: mode };
  }
  return {
    ...session,
    defaultExecutionMode: mode,
    toolPermissionContext: { ...session.toolPermissionContext, mode }
  };
}
```

Wire it into `reduceKernelSession`.

```ts
if (action.type === "default_execution_mode_set") return applyDefaultExecutionMode(session, action.mode);
```

- [ ] **Step 4: Project default execution mode**

In `src/kernel/appState.ts`, add the import and field.

```ts
import type { DefaultExecutionMode, KernelSession, PendingInteraction, WorkflowBinding } from "./session.js";

export type KernelAppState = {
  id: string;
  status: KernelSession["status"];
  pendingInteraction: PendingInteraction | null;
  planState: PlanSessionState | null;
  workflowBinding: WorkflowBinding | null;
  messageCount: number;
  permissionMode: KernelSession["toolPermissionContext"]["mode"];
  defaultExecutionMode: DefaultExecutionMode;
};
```

Return it from `projectKernelAppState`.

```ts
defaultExecutionMode: session.defaultExecutionMode
```

- [ ] **Step 5: Run Kernel session tests**

Run: `npm test -- tests/kernel/session.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/kernel/session.ts src/kernel/appState.ts tests/kernel/session.test.ts
git commit -m "feat: add kernel default execution mode"
```

## Task 2: Plan Mode Restores Selected Default Execution Mode

**Files:**
- Modify: `src/kernel/session.ts`
- Modify: `src/kernel/plan/planModeController.ts`
- Test: `tests/kernel/planModeController.test.ts`

- [ ] **Step 1: Write failing PlanModeController tests**

Add these tests to `tests/kernel/planModeController.test.ts`.

```ts
it("enters Plan Mode with selected full access as pre-plan mode", () => {
  const controller = new PlanModeController();
  const base = reduceKernelSession(createKernelSession({
    id: "s1",
    cwd,
    permissions: { mode: "default", allow: [], ask: [], deny: [] }
  }), { type: "default_execution_mode_set", mode: "bypassPermissions" });

  const planning = controller.enterPlanMode(base, { request: "build" });

  assert.equal(planning.defaultExecutionMode, "bypassPermissions");
  assert.equal(planning.toolPermissionContext.mode, "plan");
  assert.equal(planning.planState?.prePlanMode, "bypassPermissions");
});

it("updates the restore mode while staying in Plan Mode", () => {
  const controller = new PlanModeController();
  const planning = controller.enterPlanMode(createKernelSession({
    id: "s1",
    cwd,
    permissions: { mode: "default", allow: [], ask: [], deny: [] }
  }), { request: "build" });

  const updated = reduceKernelSession(planning, {
    type: "default_execution_mode_set",
    mode: "bypassPermissions"
  });

  assert.equal(updated.toolPermissionContext.mode, "plan");
  assert.equal(updated.defaultExecutionMode, "bypassPermissions");
  assert.equal(updated.planState?.prePlanMode, "bypassPermissions");
});
```

- [ ] **Step 2: Run focused PlanModeController tests and confirm failure**

Run: `npm test -- tests/kernel/planModeController.test.ts`

Expected: FAIL because Plan Mode entry still records current effective mode rather than `defaultExecutionMode`.

- [ ] **Step 3: Keep Plan restore mode synced**

Update `applyDefaultExecutionMode` in `src/kernel/session.ts`.

```ts
function applyDefaultExecutionMode(session: KernelSession, mode: DefaultExecutionMode): KernelSession {
  if (session.toolPermissionContext.mode === "plan") {
    const planState = session.planState ? { ...session.planState, prePlanMode: mode } : session.planState;
    return { ...session, defaultExecutionMode: mode, planState };
  }
  return {
    ...session,
    defaultExecutionMode: mode,
    toolPermissionContext: { ...session.toolPermissionContext, mode }
  };
}
```

- [ ] **Step 4: Update PlanModeController entry**

In `src/kernel/plan/planModeController.ts`, pass selected default execution mode into plan entry permissions.

```ts
const entryPermissions = { ...session.toolPermissionContext, mode: session.defaultExecutionMode };
const entered = enterPlanMode({ sessionId: session.id, cwd: session.cwd, originalInput, permissions: entryPermissions });
return { ...session, status: "planning", planState: entered.state, toolPermissionContext: entered.permissions };
```

- [ ] **Step 5: Run focused Kernel tests**

Run: `npm test -- tests/kernel/planModeController.test.ts tests/kernel/queryEngine.test.ts`

Expected: PASS, including `ExitPlanMode` approval when pre-plan mode is `bypassPermissions`.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/kernel/session.ts src/kernel/plan/planModeController.ts tests/kernel/planModeController.test.ts
git commit -m "feat: restore selected execution mode after plan"
```

## Task 3: TUI Mode Cycle Uses Kernel Projection

**Files:**
- Modify: `src/tui/TuiApp.tsx`
- Modify: `src/tui/eventAdapter.ts`
- Modify: `src/tui/state.ts`
- Test: `tests/tui/tuiAppPlanMode.test.tsx`

- [ ] **Step 1: Write failing TUI cycle tests**

Update the existing cycle test in `tests/tui/tuiAppPlanMode.test.tsx`.

```ts
it("cycles between default execution mode and Plan Mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
  const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

  await sendKey(output, { name: "tab", shift: true });
  await waitForFrame(output, /Permission mode: Plan/);

  await sendKey(output, { name: "tab", shift: true });
  await waitForFrame(output, /Permission mode: Default/);

  assert.doesNotMatch(output.lastFrame() ?? "", /Auto-accept edits|Bypass permissions/);
});

it("cycles between full access and Plan Mode when full access is selected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-full-access-"));
  const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} settings={{ permissions: { defaultMode: "bypassPermissions" } }} />);

  await waitForFrame(output, /permission full access/i);
  await sendKey(output, { name: "tab", shift: true });
  await waitForFrame(output, /Permission mode: Plan/);
  await sendKey(output, { name: "tab", shift: true });
  await waitForFrame(output, /Permission mode: Full access/);
});
```

- [ ] **Step 2: Run focused TUI tests and confirm failure**

Run: `npm test -- tests/tui/tuiAppPlanMode.test.tsx`

Expected: FAIL because current cycling is `default -> acceptEdits -> plan -> bypassPermissions -> default`.

- [ ] **Step 3: Add Kernel session projection helpers in TUI**

In `src/tui/TuiApp.tsx`, import `createKernelSession`, `projectAppState`, and `reduceKernelSession` from `src/kernel/session.ts`.

Create a Kernel session ref near existing refs.

```ts
const kernelSessionRef = useRef<KernelSession>();
if (!kernelSessionRef.current) {
  kernelSessionRef.current = createKernelSession({
    id: randomUUID(),
    cwd,
    permissions: { mode: settings?.permissions?.defaultMode === "bypassPermissions" ? "bypassPermissions" : "default", allow: [], ask: [], deny: [] }
  });
}
const kernelSession = kernelSessionRef.current;
```

Add helpers inside `TuiApp`.

```ts
const applyKernelSession = (session: KernelSession) => {
  kernelSessionRef.current = session;
  const appState = projectAppState(session);
  setState((current) => ({ ...current, inputPermissionMode: appState.permissionMode }));
};

const setDefaultExecutionMode = (mode: "default" | "bypassPermissions") => {
  applyKernelSession(reduceKernelSession(kernelSessionRef.current ?? kernelSession, { type: "default_execution_mode_set", mode }));
};
```

- [ ] **Step 4: Replace `nextInputPermissionMode` usage**

Replace the Shift+Tab block that calls `nextInputPermissionMode`.

```ts
const currentKernel = kernelSessionRef.current ?? kernelSession;
if (currentKernel.toolPermissionContext.mode === "plan") {
  const next = reduceKernelSession(currentKernel, {
    type: "permissions_set",
    permissions: { ...currentKernel.toolPermissionContext, mode: currentKernel.defaultExecutionMode }
  });
  applyKernelSession(next);
  setState((current) => ({
    ...current,
    inputPermissionMode: next.toolPermissionContext.mode,
    logMessages: [...current.logMessages, statusLog(`Permission mode: ${permissionModeLabel(next.toolPermissionContext.mode)}`)]
  }));
  return;
}
const planning = new PlanModeController().enterPlanMode(currentKernel, { request: "" });
applyKernelSession(planning);
setState((current) => ({
  ...current,
  inputPermissionMode: "plan",
  logMessages: [...current.logMessages, statusLog("Permission mode: Plan")]
}));
```

Remove the `nextInputPermissionMode` helper after no call sites remain.

- [ ] **Step 5: Route workflow start through Kernel effective mode**

Change `startWorkflowInput`.

```ts
const effectivePermissionMode = options.permissionMode ?? workflowPermissionMode((kernelSessionRef.current ?? kernelSession).toolPermissionContext.mode);
```

Pass `effectivePermissionMode` to `engine.startInteractive`.

- [ ] **Step 6: Run TUI cycle tests**

Run: `npm test -- tests/tui/tuiAppPlanMode.test.tsx`

Expected: PASS for the updated cycle tests.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/tui/TuiApp.tsx src/tui/eventAdapter.ts src/tui/state.ts tests/tui/tuiAppPlanMode.test.tsx
git commit -m "feat: derive tui mode cycle from kernel state"
```

## Task 4: `/permissions` and Full Access Guardrails

**Files:**
- Modify: `src/tui/TuiApp.tsx`
- Modify: `src/tui/components/StatusLine.tsx`
- Test: `tests/tui/components.test.tsx`
- Test: `tests/tui/tuiAppPlanMode.test.tsx`

- [ ] **Step 1: Write failing label and confirmation tests**

Add a status label test in `tests/tui/components.test.tsx`.

```tsx
const output = render(
  <StatusLine
    mode="input"
    permissionMode="bypassPermissions"
    workflowId="delivery"
    runId="run-1"
    isLoading={false}
    hasSelection={false}
    elements={["mode", "permission"]}
  />
);
assert.match(output.lastFrame() ?? "", /mode Full access/);
assert.match(output.lastFrame() ?? "", /permission full access/);
```

Add a TUI confirmation test.

```ts
it("requires confirmation before enabling full access", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-full-access-confirm-"));
  const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

  await sendTuiLine(output, "/permissions");
  await waitForFrame(output, /full access/i);
  await sendKey(output, { name: "down" });
  await sendKey(output, { name: "return" });
  await waitForFrame(output, /Enable full access/i);
  assert.match(output.lastFrame() ?? "", /edit files outside this workspace/i);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm test -- tests/tui/components.test.tsx tests/tui/tuiAppPlanMode.test.tsx`

Expected: FAIL because labels and confirmation flow are not aligned.

- [ ] **Step 3: Update status labels**

In `src/tui/components/StatusLine.tsx`, update label helpers.

```ts
function effectiveModeLabel(mode: TuiMode, permissionMode: PermissionMode): string {
  if (mode === "waiting_plan_approval") return "Plan Review";
  if (mode === "planning" || (mode === "input" && permissionMode === "plan")) return "Plan";
  if (mode === "input" && permissionMode === "bypassPermissions") return "Full access";
  if (mode === "input" && permissionMode === "auto") return "Auto";
  if (mode === "input" && permissionMode === "dontAsk") return "Don't Ask";
  return mode;
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "bypassPermissions") return "full access";
  if (mode === "plan") return "plan";
  return mode;
}
```

- [ ] **Step 4: Implement `/permissions` choices and full access confirmation**

In `src/tui/TuiApp.tsx`, make `/permissions` open a choice with `default` and `full access`. Selecting `default` calls `setDefaultExecutionMode("default")` and logs `Permissions updated to default`.

For full access, show this confirmation before applying `bypassPermissions`.

```ts
const fullAccessWarning = [
  "Enable full access?",
  "Full access can edit files outside this workspace and run commands without approval.",
  "Use this only when you explicitly accept the risk."
].join("\n");
```

After confirmation, apply the mode and log the event.

```ts
setDefaultExecutionMode("bypassPermissions");
setState((current) => ({
  ...current,
  mode: "input",
  logMessages: [...current.logMessages, statusLog("Permissions updated to full access")]
}));
```

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/tui/components.test.tsx tests/tui/tuiAppPlanMode.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/tui/TuiApp.tsx src/tui/components/StatusLine.tsx tests/tui/components.test.tsx tests/tui/tuiAppPlanMode.test.tsx
git commit -m "feat: add full access permission guardrails"
```

## Task 5: Regression Sweep

**Files:**
- No new files expected.

- [ ] **Step 1: Run Kernel and workflow tests**

Run: `npm test -- tests/kernel/session.test.ts tests/kernel/planModeController.test.ts tests/kernel/queryEngine.test.ts tests/workflow/planModeSeparation.test.ts`

Expected: PASS.

- [ ] **Step 2: Run TUI focused tests**

Run: `npm test -- tests/tui/tuiAppPlanMode.test.tsx tests/tui/kernelIntegration.test.tsx tests/tui/components.test.tsx tests/tui/eventAdapter.test.ts`

Expected: PASS.

- [ ] **Step 3: Inspect status for unrelated files**

Run: `git status --short`

Expected: implementation files only, plus any pre-existing untracked files such as `.agents/` or `agent-team.yaml`. Do not stage unrelated files.

- [ ] **Step 4: Final commit if test-only assertion changes remain**

```bash
git add tests/tui tests/kernel tests/workflow
git commit -m "test: cover permission source alignment regressions"
```

Skip this commit if no files changed after Step 2.

## Self-Review

- Spec coverage: Kernel source of truth, `/permissions` default/full access, Shift+Tab toggle, full access guardrails, Plan Mode restore behavior, and `inputPermissionMode` de-authoring are covered by Tasks 1-5.
- Placeholder scan: no placeholder markers or unspecified implementation steps remain.
- Type consistency: `DefaultExecutionMode` is consistently `"default" | "bypassPermissions"`; user-visible full access remains a label, not an internal mode.

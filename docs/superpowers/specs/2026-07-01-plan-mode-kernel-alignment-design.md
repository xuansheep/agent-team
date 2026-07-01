# Plan Mode Kernel Alignment Design

Date: 2026-07-01

## Summary

Align `agent-team` Plan Mode with the stable `tui-code` model by moving Plan Mode authority out of `TuiApp` and into the Kernel layer. The target architecture is: plan file as the only draft source of truth, Kernel-owned Plan Mode state and pending interactions, hard permission enforcement for plan-mode writes, and a dedicated `ExitPlanMode` approval interaction.

This is intentionally an architecture convergence, not a narrow prompt fix. `TuiApp` should render Kernel interactions and relay user decisions, while `KernelSession`, `QueryEngine`, and `PlanModeController` own Plan Mode state transitions.

## Goals

- Make `KernelSession.planState`, `KernelSession.toolPermissionContext`, and `KernelSession.pendingInteraction` the authoritative Plan Mode state.
- Remove model-visible `ExitPlanMode.plan`; models must write the current plan file with `Write`, `Edit`, or `MultiEdit` before calling `ExitPlanMode`.
- Keep Plan Mode permissions deterministic: read-only tools are allowed, `Write/Edit/MultiEdit` are allowed only for the current session plan file, and ordinary source edits, shell execution, and workflow execution are denied.
- Make the Plan approval UI driven by `pendingInteraction.type === "plan_approval"`, not by TUI-owned `pendingReview` state.
- Preserve user-visible TUI behavior: long plan review, accept choices, feedback on rejection, `/plan open`, resume behavior, and execution after approval.

## Non-Goals

- Do not move plan files from `.session/plans` to a global tui-code-style directory.
- Do not remove approved plan text from workflow handoff; execution still receives the approved plan after approval.
- Do not rewrite the entire TUI state model beyond what is needed to make Plan Mode Kernel-owned.
- Do not introduce a second approval path or a natural-language approval fallback.

## Architecture

### Kernel-owned Plan Mode

`KernelSession` becomes the single source for Plan Mode state:

- `planState` stores session id, plan file path, original input, pre-plan permission mode, requested permissions, feedback, and approved plan metadata.
- `toolPermissionContext` stores the effective permission mode and the current `planFilePath` while in Plan Mode.
- `pendingInteraction` stores `plan_approval`, `ask_user_question`, and permission requests that require user action.

`PlanModeController` owns the Plan Mode transitions:

- `enterPlanMode(session, originalInput)` sets `planState.mode = "planning"`, records `prePlanMode`, assigns `planFilePath`, and switches permissions to `mode = "plan"`.
- `requestPlanApproval(session, request)` reads the current plan file, creates `pendingInteraction.type = "plan_approval"`, and moves `planState.mode` to `waiting_approval`.
- `resolvePlanApproval(session, decision, metadata)` handles continue versus stay, restores or preserves permissions, stores feedback, and builds the approved handoff.
- `recoverPlanDocument(session)` reads the plan file or delegates transcript recovery where applicable.

`QueryEngine` becomes the dispatcher for interactive tools:

- `EnterPlanMode` updates the Kernel session through `PlanModeController`.
- `ExitPlanMode` never accepts plan text from model input. It asks `PlanModeController` to request approval from the plan file.
- `AskUserQuestion` becomes a Kernel `pendingInteraction`, like plan approval.
- Tool calls that create pending interactions stop the current query loop and return a session snapshot to the UI.

### TUI as Interaction Renderer

`TuiApp` should stop being the Plan Mode business state owner. Its responsibilities become:

- Render `KernelSession.pendingInteraction` via `kernelAdapter` into existing TUI choice prompts.
- Open or refresh the current plan file using `kernelSession.planState.planFilePath` or `pendingInteraction.planFilePath`.
- Relay user choices back to Kernel actions such as `resolve_plan_approval`, `answer_user_question`, or `resolve_permission`.
- Start workflow execution only when Kernel returns an approved handoff or equivalent post-approval result.

The existing visual behavior can remain, but data should come from Kernel state:

- `PlanReviewPrompt` renders `pendingInteraction.document` and metadata.
- Accept choices pass permission-mode intent and clear-context intent as resolution metadata.
- Reject choices pass feedback and optional image/text payloads to Kernel, which stores them in `planState.feedbackMessages` and leaves permissions in Plan Mode.
- `/plan open` and Ctrl+G edit the current plan file, then Kernel refreshes the approval document from disk.

## Tool and Prompt Protocol

`ExitPlanMode` changes to match tui-code:

- Model-visible schema includes `allowedPrompts` only.
- Model-visible schema does not include `plan` or `planFilePath`.
- Internal execution can still receive Kernel context or session state, but that is not model-facing input.
- The tool reads the current plan file through `PlanModeController` or `planSession` and creates a plan approval request from that file.

Plan Mode prompts and attachments must consistently say:

- The plan file is the only writable file in Plan Mode.
- Write or update the plan with `Write`, `Edit`, or `MultiEdit`.
- Call `ExitPlanMode` with no plan text when the plan file is ready for approval.
- Do not ask for plan approval via plain text or `AskUserQuestion`.

Remove or replace all guidance that says:

- Pass the complete plan as `ExitPlanMode.plan`.
- `ExitPlanMode` stores the plan parameter in the plan file.
- Recovery can use `ExitPlanMode.input.plan` as a source of truth.

## Permission Rules

Plan Mode permission policy must be enforced in Kernel and legacy permission paths consistently:

- Allow read-only tools.
- Allow `AskUserQuestion` and `ExitPlanMode` only as interaction tools.
- Allow `TodoWrite` only if the existing planning checklist behavior is intentionally retained.
- Allow `Write`, `Edit`, and `MultiEdit` only when their normalized target path exactly equals the current session plan file path.
- Deny `ArtifactWrite` and ordinary source writes in Plan Mode unless a later design explicitly treats an artifact as an internal plan file.
- Deny `Bash`, `PowerShell`, workflow execution tools, and agent task execution in Plan Mode.
- Continue returning denial messages to the model so it can recover by editing the plan file or calling the right interaction tool.

Path checks should normalize absolute and relative paths through the same helper used by local tools. Do not allow broad `.session/plans` writes; only the exact current session plan file should be writable.

## Plan File and Recovery

The plan file remains under the existing `.session/plans` strategy. The current `getPlanFilePath(sessionId, cwd, plansDirectory)` behavior can stay.

Recovery should use these sources, in order:

- Existing plan file on disk.
- Transcript reconstruction from `Write`, `Edit`, and `MultiEdit` calls targeting the current plan file.
- Session store plan state and approved plan metadata for already-approved sessions.

Recovery must stop using `ExitPlanMode.input.plan`. If a waiting approval session has no recoverable plan file content, show the existing empty-plan approval path.

## Data Flow

### Enter Plan Mode

1. User selects Plan Mode or model calls `EnterPlanMode`.
2. `QueryEngine` routes this to `PlanModeController.enterPlanMode`.
3. Kernel updates `planState`, `toolPermissionContext.mode = "plan"`, and `planFilePath`.
4. TUI renders Plan Mode status from the Kernel snapshot.
5. Runtime attachments instruct the model to write only the plan file.

### Draft Plan

1. Model explores with read-only tools.
2. Model writes or edits the current plan file with `Write`, `Edit`, or `MultiEdit`.
3. `PermissionKernel` allows only the exact current plan file path.
4. All other writes are denied and returned as tool results.

### Request Approval

1. Model calls `ExitPlanMode` with no plan text.
2. `QueryEngine` validates that Plan Mode is active.
3. `PlanModeController.requestPlanApproval` reads the current plan file.
4. Kernel sets `pendingInteraction.type = "plan_approval"` with a document snapshot.
5. TUI renders the fixed approval UI.

### Resolve Approval

1. User chooses accept or keep planning.
2. TUI sends the decision and metadata to Kernel.
3. On accept, Kernel stores the approved plan, restores the chosen execution permission mode, and returns approved handoff for workflow execution.
4. On reject, Kernel stores feedback, keeps Plan Mode active, and the next model turn continues planning.

## Compatibility

This is a breaking internal protocol change for model-facing tools:

- Tests and providers that call `ExitPlanMode` with `{ plan: "..." }` must instead write the plan file first, then call `ExitPlanMode` with `{}` or `{ allowedPrompts }`.
- Public SDK helper methods may keep accepting a plan string if they first write it to the session plan file internally before requesting approval.
- `PlanApprovalRequest.document` stays as a UI snapshot generated from the plan file.
- Approved workflow handoff keeps `approved_plan`, `plan_file_path`, requested permissions, and approval feedback.

## Test Plan

- Permission tests verify Plan Mode allows only read-only tools and exact current plan file writes, while denying source writes, shell tools, workflow execution, and other plan files.
- Tool schema tests verify `ExitPlanMode.input_schema.properties` contains `allowedPrompts` and excludes `plan`, `planFilePath`, and internal `state`.
- Runtime and Kernel tests cover: write plan file, call empty `ExitPlanMode`, receive Kernel `pendingInteraction.plan_approval`, approve, and start workflow from approved handoff.
- TUI tests cover approval rendering from Kernel pending interaction, long plan document display with choices visible, accept modes, rejection feedback, `/plan open`, and Ctrl+G refresh.
- Resume tests cover restoring planning and waiting-approval sessions from session store and plan file, plus transcript recovery from plan-file writes only.
- Regression tests update all fake model providers to write the plan file before calling `ExitPlanMode`.

## Risks

- `TuiApp.tsx` currently owns a lot of Plan Mode state. Moving it into Kernel can cause regressions in `/plan`, `/resume`, image feedback, and clear-context acceptance.
- There are existing tests that encode the old `ExitPlanMode.plan` behavior. They must be updated deliberately, not patched around.
- Kernel and legacy runtime paths must remain consistent during migration. A partial migration would create two Plan Mode authorities.
- Empty-plan approval must remain explicit, otherwise a missing plan file could accidentally look like a normal approved plan.

## Acceptance Criteria

- In Plan Mode, ordinary source edits cannot execute through any tool path.
- The only writable Plan Mode file is the current session plan file.
- `ExitPlanMode` is model-visible without `plan` or `planFilePath` fields.
- Plan approval UI always comes from Kernel `pendingInteraction.plan_approval`.
- TUI no longer owns independent `pendingReview` or `resolveGlobalPlan` business logic for Plan Mode approval.
- Resuming waiting approval reads the plan document from the plan file or from transcript reconstruction of plan-file writes.
- The test suite passes after updating old `ExitPlanMode.plan` assumptions.

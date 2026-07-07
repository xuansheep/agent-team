# Mode and Permission Source Alignment Design

Date: 2026-07-07

## Goal

Align mode switching with the kernel-owned architecture and make permission state observable from one source of truth. The target behavior is:

- The user-visible default execution mode is named `default`.
- `/permissions` switches the default execution mode between `default` and `full access`.
- `default` maps to the existing internal `default` permission mode and is equivalent to `tui-code` default behavior.
- `full access` maps to the existing internal `bypassPermissions` permission mode, but must be treated as a high-risk permission profile with confirmation, status visibility, and audit/history output.
- Normal mode cycling uses the current default execution mode as the non-plan side of the toggle:
  - default execution mode `default`: `default -> plan -> default`
  - default execution mode `full access`: `full access -> plan -> full access`
- Plan Mode remains a temporary collaboration/exploration mode and is not a selectable default execution mode.
- `inputPermissionMode` must stop being a source of truth. TUI may display an input mode projection, but the authoritative state must come from the Kernel/AppState projection.

## Non Goals

- Do not rename the internal `PermissionMode.default` enum value in this change.
- Do not introduce a user-visible `edit` alias.
- Do not copy the full Codex permission profile system, such as read-only, auto-review, custom profiles, or managed filesystem profile configuration.
- Do not allow workflow node `mode: plan` or `permission_mode: plan`.
- Do not let full access bypass Plan Mode approval interactions such as `ExitPlanMode`.

## Reference Facts

### Current Project

- `PermissionMode` currently includes `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`.
- `KernelSession.toolPermissionContext` and `KernelSession.planState` already model the intended Kernel-owned Plan Mode state.
- `PlanModeController` already records `prePlanMode`, switches permissions to `plan`, creates Kernel-owned `pendingInteraction.type = "plan_approval"`, and restores the pre-plan mode when the plan is approved.
- `TuiApp` still maintains `inputPermissionMode` and currently cycles `default -> acceptEdits -> plan -> bypassPermissions -> default`, which conflicts with the new desired mode cycling.
- Current Plan Mode permission enforcement is split between Kernel and legacy permission paths, but both already enforce the same core invariant: only the current session plan file is writable in Plan Mode.

### tui-code

- `tui-code` external permission modes include `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`, and `plan`.
- Its Shift+Tab behavior cycles through several modes depending on runtime gates and terminal/product conditions.
- Plan Mode transitions capture `prePlanMode`, switch to `plan`, and restore the prior non-plan mode when leaving Plan Mode.
- Its TUI state reflects permission context changes, but permission transition side effects are centralized rather than owned by an input component.

### Codex

- `/permissions` in `codex` selects a preset made from approval policy plus permission profile.
- The Codex `Default` preset is `AskForApproval::OnRequest` plus the built-in workspace profile.
- The Codex `Full Access` preset is `AskForApproval::Never` plus the built-in danger full-access profile, which compiles to disabled sandboxing.
- Codex shows a full-access confirmation prompt and records a permission update history cell.
- We should borrow the safety semantics, not the whole profile model.

## Target Architecture

### Authority

The authoritative permission state lives in Kernel session state and is projected outward through AppState.

TUI may keep local UI state for focus, input buffer, selected popup row, and transient rendering, but not for permission authority.

The authoritative fields should be:

- `toolPermissionContext.mode`: effective current runtime mode, including `plan` while planning.
- `planState.prePlanMode`: the runtime mode to restore after Plan Mode approval.
- `defaultExecutionMode`: the non-plan execution mode selected by `/permissions`.

`defaultExecutionMode` should only permit the two target values:

- `default`
- `bypassPermissions`

User-visible labels:

| Internal value | User-visible label | Meaning |
|---|---|---|
| `default` | `default` | Workspace-scoped editing and normal approval behavior. Equivalent to tui-code default. |
| `bypassPermissions` | `full access` | Full access behavior. High risk. Requires explicit confirmation before enabling. |
| `plan` | `plan` | Temporary planning mode. Not a default execution mode. |

### Mode Cycling

Cycling must be derived from Kernel state:

1. If current effective mode is `plan`, switch to `defaultExecutionMode`.
2. Otherwise, enter Plan Mode and record `prePlanMode = defaultExecutionMode`.

The cycle must not enumerate `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions` independently. `bypassPermissions` can only participate in normal cycling when it is the selected `defaultExecutionMode`.

### `/permissions`

`/permissions` should mutate `defaultExecutionMode`, not a TUI-local input mode.

The menu should contain only:

| Option | Internal target | Safety behavior |
|---|---|---|
| `default` | `defaultExecutionMode = default` | Can apply directly. |
| `full access` | `defaultExecutionMode = bypassPermissions` | Requires explicit confirmation before first/session enable. |

When the current effective mode is not `plan`, applying `/permissions` should also update `toolPermissionContext.mode` to the selected execution mode so the next turn uses the selected permission level.

When the current effective mode is `plan`, applying `/permissions` should update only `defaultExecutionMode` and `planState.prePlanMode` as appropriate, while remaining in Plan Mode. The plan approval path should restore to the updated default execution mode.

### Full Access Safety

Full access must not be a silent mode change.

Minimum required behavior:

- show an explicit confirmation prompt before enabling full access;
- state that full access can edit outside the workspace and run without approval;
- emit a history/audit item when full access is enabled;
- make the status line/header visibly show `full access` while active;
- keep Plan Mode approval interactions mandatory even if full access is the selected default execution mode;
- allow returning from full access to default without confirmation.

For this project's risk profile, full access should also be easy to detect in tests and logs.

### Plan Mode Approval

Plan Mode approval remains Kernel-owned:

- `ExitPlanMode` creates or returns a Kernel `pendingInteraction.type = "plan_approval"`.
- Approval with continue restores `toolPermissionContext.mode` to `planState.prePlanMode`, which should match the current `defaultExecutionMode` unless deliberately overridden by approved metadata.
- Rejection leaves the session in Plan Mode.
- Clear-context approval must preserve approved plan text, plan file path, original input, requested permissions, selected execution mode, and approval feedback.

Full access must never short-circuit `ExitPlanMode`, `AskUserQuestion`, or any other interaction tool that requires user review.

## Required Code Changes

### Kernel/AppState

- Add or formalize `defaultExecutionMode` on Kernel session or the Kernel-owned UI state projection.
- Project `defaultExecutionMode`, effective `permissionMode`, and `planState` through `appState`.
- Ensure `PlanModeController.enterPlanMode` records `prePlanMode` from `defaultExecutionMode` when entering via normal user cycling.
- Ensure `PlanModeController.resolvePlanApproval` restores the selected default execution mode.

### TUI

- Remove `inputPermissionMode` as a source of truth from `TuiState` and `TuiApp` business logic.
- Replace `nextInputPermissionMode` with a Kernel-intent based cycle:
  - `cycleMode()` sends `enterPlanMode` when effective mode is not `plan`.
  - `cycleMode()` sends `setPermissionMode(defaultExecutionMode)` when effective mode is `plan`.
- Render status and prompt footer from AppState projection.
- Keep any remaining local `inputPermissionMode` only as a derived display value if removing it in one pass is too invasive.

### Commands

- `/permissions` should dispatch a Kernel-level intent to set the default execution mode.
- The command should not mutate a TUI-local mode field.
- `/plan` should remain an explicit entry into Plan Mode and share the same Kernel transition path as Shift+Tab.

### Permission Pipeline

- Preserve Plan Mode write restrictions:
  - read-only tools allowed;
  - `Write`, `Edit`, and `MultiEdit` allowed only for the exact current session plan file;
  - shell, workflow, and source-file edits denied in Plan Mode.
- Preserve interaction-tool behavior:
  - `ExitPlanMode` and `AskUserQuestion` create pending interactions;
  - `bypassPermissions` does not auto-approve these interactions.

## Test Plan

Add or update focused tests for:

1. Default cycle: selected default execution mode `default` gives `default -> plan -> default`.
2. Full access cycle: selected default execution mode `bypassPermissions` gives `full access -> plan -> full access`.
3. `/permissions` from normal mode applies the selected default execution mode to both `defaultExecutionMode` and effective `toolPermissionContext.mode`.
4. `/permissions` while in Plan Mode updates the post-plan restore mode but keeps effective mode `plan`.
5. Plan approval restores `default` when default execution mode is default.
6. Plan approval restores `bypassPermissions` when default execution mode is full access.
7. Plan rejection leaves effective mode `plan`.
8. Full access requires confirmation before enabling.
9. Full access emits visible history/audit output.
10. `ExitPlanMode` still creates plan approval when `prePlanMode` is `bypassPermissions`.
11. Workflow schema continues rejecting `mode: plan` and `permission_mode: plan`.
12. Status/footer display comes from AppState, not `inputPermissionMode`.

## Migration Notes

- Existing internal values such as `acceptEdits`, `auto`, and `dontAsk` should not be removed unless they are proven unused outside the requested surface. This design only removes them from normal user cycling and `/permissions` default selection.
- Existing tests that expect the old `default -> acceptEdits -> plan -> bypassPermissions` cycle must be updated to the new two-state cycle based on `defaultExecutionMode`.
- If older session metadata stores `inputPermissionMode`, it should be treated as display-only legacy data and not override Kernel state.

## Risks

| Risk | Mitigation |
|---|---|
| UI shows one mode while Kernel runs another | Make Kernel/AppState projection the only display source. |
| Full access is enabled accidentally | Confirmation prompt, audit/history output, and status visibility. |
| Plan approval is bypassed by full access | Keep interaction tools outside auto/bypass permission fast paths. |
| Existing tests rely on multi-mode Shift+Tab | Update tests to assert the new explicit product behavior. |
| Over-copying Codex permissions | Limit this change to default/full access selection and Plan Mode restore semantics. |

## Acceptance Criteria

- There is one authoritative permission state path from Kernel to AppState to TUI display.
- `inputPermissionMode` no longer determines runtime permissions.
- `/permissions` changes the default execution mode between `default` and `full access` only.
- Shift+Tab cycles between Plan Mode and the selected default execution mode.
- Full access cannot be enabled silently.
- Plan Mode approval and rejection behavior remains deterministic and Kernel-owned.

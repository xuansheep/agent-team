# Permission Mode Tightening Design

Date: 2026-07-07

## Goal

Tighten the permission model to three runtime modes and remove the legacy permission-mode surface completely.

The only valid `PermissionMode` values after this change are:

- `default`
- `fullAccess`
- `plan`

`fullAccess` is a direct rename of the existing `bypassPermissions` behavior. The legacy modes `acceptEdits`, `auto`, and `dontAsk` are removed from runtime behavior, schemas, UI, SDK entrypoints, tests, and documentation. Old persisted values are not migrated or accepted.

## Target Semantics

- `default`: use configured `deny`, `ask`, and `allow` rules. If no rule matches, ask.
- `fullAccess`: preserve explicit `deny` precedence, then allow all other tool calls. It must not bypass Plan Mode interactions or other user-interaction tools.
- `plan`: temporary planning mode only. It remains unavailable as a workflow node `permission_mode` and as workflow run execution mode.

Workflow node `permission_mode` accepts only `default` and `fullAccess`.

Settings `permissions.defaultMode` accepts `default`, `fullAccess`, and `plan`; `plan` remains only a startup/default-entry shortcut into Plan Mode.

Workflow run `permissionMode` and stored `run_permission_mode` accept only non-plan execution modes: `default` and `fullAccess`.

## Hard-Cut Compatibility Policy

This is a hard cut, not a compatibility migration.

- `bypassPermissions` is replaced by `fullAccess` everywhere.
- `acceptEdits`, `auto`, and `dontAsk` permission handling code is removed.
- Config, settings, SDK input, tool input, run state, and plan session state that contain old values fail validation or type checks.
- No hidden mapping from old values to new values is added.
- Existing users must manually update old configuration and discard or repair old session metadata if needed.

This is intentionally stricter than the earlier mode-source-alignment design, which kept internal `bypassPermissions` and retained old modes outside the user-facing surface.

## Implementation Boundaries

### Type and Schema Sources

Update all permission-mode enum sources to the new values:

- `src/permissions/PermissionMode.ts`
- `src/config/schema.ts`
- `src/settings/types.ts`
- `src/sdk/schemas.ts`
- local tool schemas for `EnterPlanMode` and `ExitPlanMode`
- Plan/session/workflow state types that reference `PermissionMode`

`DefaultExecutionMode` becomes `default | fullAccess`.

### Permission Pipeline

Simplify `checkToolPermission` to this ordered flow:

1. Check explicit `deny` first for every mode.
2. If mode is `plan`, apply existing Plan Mode restrictions.
3. If mode is `fullAccess`, allow the call.
4. Otherwise run normal `decidePermission` for `default`.

Remove the helper functions and branches for `acceptEdits`, `auto`, and `dontAsk`.

Keep existing Plan Mode protections:

- read-only tools are allowed;
- `AskUserQuestion` stays allowed in Plan Mode;
- `ExitPlanMode` remains an approval interaction;
- writes are limited to the current plan file;
- shell and workflow execution tools are blocked in Plan Mode.

### Kernel, Plan, and Workflow

- Rename `bypassPermissions` references to `fullAccess` in `KernelSession`, `DefaultExecutionMode`, AppState projection, and `PlanModeController`.
- Plan approval restore uses `defaultExecutionMode`, now `default | fullAccess`.
- `WorkflowRunPermissionMode = Exclude<PermissionMode, "plan">` naturally becomes `default | fullAccess`.
- Stored workflow state writes `run_permission_mode: "fullAccess"` for full-access runs.
- Model routing no longer needs behavior for `auto`, `acceptEdits`, or `dontAsk`.

### TUI

- `/permissions` keeps user options `Default` and `Full access`; internal value is `fullAccess`.
- Shift+Tab toggles only between Plan Mode and the selected default execution mode.
- Status line, header, logs, and permission labels use `full access` for `fullAccess`.
- Remove Plan approval options and fast-accept behavior that produce `acceptEdits` or `auto`.
- Remove UI and tests for Auto Mode, Accept Edits, Don't Ask, and Bypass Permissions wording.

### Runtime Attachments and Prompts

Remove Auto Mode runtime attachment behavior if it is only reachable through removed `auto` mode. Any tests expecting `auto_mode`, `auto_mode_reminder`, or `auto_mode_exit` attachments must be deleted or rewritten to new `default/fullAccess/plan` behavior.

## Error Handling

The implementation should fail loudly when old values appear.

- Zod schemas reject old values.
- Restoring old session metadata with stale `prePlanMode` or `run_permission_mode` is allowed to fail.
- No migration warning path is required because no legacy compatibility branch should remain.

`fullAccess` must still respect explicit deny rules and must not short-circuit Plan Mode approval or user-question interactions.

## Test Plan

Focused tests should cover:

- `PermissionMode` schemas accept only `default`, `fullAccess`, and `plan` where appropriate.
- Workflow node `permission_mode` accepts `default/fullAccess` and rejects `plan` plus all legacy values.
- Settings `permissions.defaultMode` accepts `default/fullAccess/plan` and rejects all legacy values.
- SDK query schema accepts only the new values.
- `default` mode preserves allow/ask/deny behavior.
- `fullAccess` defaults to allow while explicit deny still wins.
- Plan Mode still restricts writes and execution tools.
- `ExitPlanMode` still produces a plan approval interaction when pre-plan mode is `fullAccess`.
- Workflow run state persists `run_permission_mode: "fullAccess"`.
- `/permissions` and Plan approval start workflows with `permissionMode: "fullAccess"` when selected.
- Status line and TUI copy show `full access` and never show `bypass`, `Auto`, `Accept Edits`, or `Don't Ask`.

After implementation, run a repository search for legacy values. Production code should not contain `acceptEdits`, `dontAsk`, or `bypassPermissions`. `auto` may still appear in unrelated contexts such as provider tool choice, layout values, or generic UI behavior, but not as a permission mode or Auto Mode runtime attachment.

## Acceptance Criteria

- `PermissionMode` is exactly `default | fullAccess | plan`.
- Permission checking has no `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions` branch.
- All public schemas and tool schemas use the new values.
- `/permissions`, Plan Mode, WorkflowEngine, SDK, and status display all use `fullAccess` internally for full access.
- Legacy permission values fail validation instead of being migrated.
- Focused permission, schema, kernel, workflow, and TUI tests pass.

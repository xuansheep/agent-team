# Tui-Code Replication Scope

## Purpose

This document fixes the replication boundary for aligning `agent-team` with the core local behavior of `tui-code`. The target is behavior compatibility for local conversation runtime, permissions, tools, sessions, Plan Mode, plugins, tasks, and headless SDK usage.

The target is not source-level replacement. `agent-team` keeps its current `workflow`, `harness`, and `tui` execution boundary while introducing a conversation-first runtime that workflow execution can reuse.

## Strategy Legend

- `replicate`: implement the behavior as a first-class local capability.
- `adapt`: preserve the behavior intent, but map it to the current `agent-team` architecture.
- `defer`: document the boundary now and implement in a later phase.
- `exclude`: intentionally do not implement.

## Module Scope

| `tui-code` area | Strategy | `agent-team` target |
| --- | --- | --- |
| `QueryEngine` | replicate | Add a conversation-first runtime turn executor independent from workflow graph execution. |
| `query.ts` | adapt | Route CLI and TUI user input into either workflow execution, Plan Mode conversation, or command handling. |
| `Tool` | replicate | Extend the local tool contract with metadata for read-only behavior, concurrency safety, destructive checks, validation, and model result mapping. |
| `tools/` | adapt | Keep existing local tools, then add orchestration and permission-aware execution around them. |
| `PermissionMode` | replicate | Add session-level modes: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`. |
| `utils/permissions/` | replicate | Centralize permission checks so local tools, MCP tools, plugin tools, workflow execution, and headless API calls cannot bypass the same policy. |
| `Plan Mode` | replicate | Implement global pre-workflow Plan Mode as a safety mode. Workflow node `mode: "plan"` is no longer supported. |
| `utils/plans.ts` | adapt | Store plan drafts under `.session/plans/` and allow writes only to the current session plan file while in Plan Mode. |
| `Session Storage` | replicate | Expand run state into session transcript, metadata, plan state, and index files while retaining old run fallback. |
| `utils/messages.ts` | adapt | Build runtime messages through a shared context pipeline for workflow handoff, Plan Mode attachments, images, and reviews. |
| `utils/attachments.ts` | adapt | Inject Plan Mode constraints, plan drafts, and exit messages as model-visible context. |
| `commands/` | replicate | Add a command registry and slash command routing, starting with `/plan`, `/clear`, `/resume`, `/model`, and `/permissions`. |
| `services/mcp/` | defer | Add a local MCP tool adapter later. MCP tools must use the unified tool and permission contracts. |
| `plugins/` | defer | Load local plugin manifests later for commands, tools, and skills. Plugins must not bypass permission checks. |
| `skills/` | defer | Load local skill prompt content later. Skill loading is local-only and does not include a marketplace. |
| `tasks/` | defer | Add local Tasks support for background tasks and local agent orchestration later. Remote agent execution is excluded. |
| `bridge/` | exclude | Remote bridge, remote transport, and remote resume are out of scope. |
| `entrypoints/sdk/` | adapt | Add a local in-process SDK/headless API that reuse runtime, permissions, Plan Mode, and audit events. |
| TUI logging excluded | exclude | Do not replicate the `tui-code` TUI logging system. Keep only local audit events required for safety. |
| Telemetry | exclude | Do not add default outbound telemetry. |
| Remote excluded | exclude | Do not implement remote capabilities, remote control planes, remote transport, remote resume, or remote agents. |

## Required Safety Boundaries

Plan Mode is a process-before-execution safety mode. Before a user approves a plan, the system must not start workflow execution, advance workflow nodes, write ordinary project files, run shell write operations, start background execution tasks, or allow extensions to bypass permission checks.

Workflow node `mode: "plan"` is removed from the supported model. Plan Mode is a session/TUI-level permission mode only, and workflow nodes must reject both `mode: "plan"` and `permission_mode: "plan"` configuration.

All high-risk capabilities, including shell commands, file writes, SDK calls, MCP tools, plugin tools, and task orchestration, must produce local audit evidence before they are enabled for production workflows.

## Explicit Non-Goals

- Do not replicate the TUI logging system.
- Do not enable outbound telemetry by default.
- Do not implement remote capabilities.
- Do not create remote transport.
- Do not implement remote resume.
- Do not implement a remote agent or external control plane.
- Do not move product settings into `agent-team.yaml`.
- Do not replace the workflow harness with a copied `tui-code` kernel.

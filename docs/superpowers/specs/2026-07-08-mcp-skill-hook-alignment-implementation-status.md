# MCP Skill Hook Alignment Implementation Status

Date: 2026-07-08

This document records the current implementation status for the tui-code alignment work across MCP, Skill, and Hook capabilities.

## Status Summary

| Area | Status |
|---|---|
| MCP phase one | Implemented |
| Skill runtime | Implemented |
| Skill hooks | Implemented |
| Hook runtime | Implemented |
| TUI diagnostics | Implemented |
| Plugin skills | Out of scope |
| claudeai-proxy | Out of scope for phase one |
| Authentication | Out of scope |

## MCP

Implemented:

- Config sources: user `~/.einsteins/mcp.json`, project `.mcp.json`, and `agent-team.yaml` `mcpServers`.
- Precedence: `agent-team.yaml` over project `.mcp.json` over user config.
- Transports: `stdio`, `http`, `sse`, and `ws`.
- JSON-RPC lifecycle: initialize before capability discovery, with initialized notification support.
- Server isolation: individual server failures are recorded without failing the entire runtime.
- Failed initialization cleanup: initialized client failures close the client when possible.
- Capability caches: tools, resources, and prompts.
- Tools: `ToolSearch`, deferred MCP tools, `ListMcpResources`, `ReadMcpResource`, `ListMcpPrompts`, `GetMcpPrompt`, and `RunMcpPrompt`.
- Diagnostics: server state, source, error, and tool/resource/prompt counts.

Verification:

- HTTP JSON-RPC local test passes.
- SSE single-response payload test passes.
- JSON-RPC method mapping test passes.
- Initialize lifecycle test passes.
- Real stdio child-process tests are present and skip safely when the sandbox blocks `child_process.spawn` with `EPERM`.

Blocked in current environment:

- A non-skipped real stdio E2E run requires an environment that allows `child_process.spawn`. The current approval policy rejected sandbox escalation.

## Skill

Implemented:

- Skill discovery is intentionally limited to project `.agents/skills` and user `~/.einsteins/skills`; project skills take precedence over same-name user skills.
- Metadata parsing for name, description, when-to-use, allowed tools, model, effort, mode, and hooks.
- Inline skill activation into model context.
- Fork skill execution through a constrained child model request.
- MCP prompt skill adapter.
- `ListSkills` and `UseSkill` tools.
- Skill routing prompt exposure in Plan Mode.
- Skill diagnostics.

## Hooks

Implemented:

- Hook types: `command`, `prompt`, `agent`, `http`, and `function`.
- Wired events: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop`.
- Hook sources: settings, session, skill, and builtin.
- Skill hooks are session scoped.
- Skill hook deduplication across repeated `UseSkill` activation.
- Session hook cleanup when a Plan Mode session is approved and handed off.
- Diagnostics include source, wired status, disabled state, and last execution.
- Agent hooks now run a constrained child loop and may call only read-only non-interactive supplied tools.

## Settings

Implemented:

- User settings canonical path: `~/.einsteins/settings.yaml`.
- Legacy fallback: `~/.agent-team/settings.yaml`.
- Project settings remain project-scoped and are not part of the user settings migration.

## Verification Commands

Last successful verification:

```powershell
npm run build:test
node .tmp\run-selected-tests.mjs dist-test\tests\mcp\config.test.js dist-test\tests\mcp\jsonRpcClient.test.js dist-test\tests\mcp\connectionManager.test.js dist-test\tests\mcp\deferredTools.test.js dist-test\tests\mcp\resourceTools.test.js dist-test\tests\mcp\promptTools.test.js dist-test\tests\skills\skillRuntime.test.js dist-test\tests\skills\skillTools.test.js dist-test\tests\skills\mcpSkills.test.js dist-test\tests\skills\skillHooks.test.js dist-test\tests\hooks\runtime.test.js dist-test\tests\workflow\hooks.test.js dist-test\tests\diagnostics\runtimeDiagnostics.test.js dist-test\tests\runtime\turnExecutor.test.js dist-test\tests\kernel\queryEngine.test.js dist-test\tests\tui\startup.test.js dist-test\tests\tui\tuiAppPlanMode.test.js
```

Result: `186 tests, 0 fail, 2 skipped`.

The skipped tests are stdio child-process tests blocked by the current sandbox. They should pass or expose real environment defects when run in a normal Node environment that permits spawning `process.execPath`.

## Remaining Work

- Run non-skipped real stdio MCP smoke tests in a spawn-capable environment.
- Perform final diff review and split commits if desired.
- Ask for task number before committing, per repository instructions.
- Clean `.tmp/` only after explicit user approval.

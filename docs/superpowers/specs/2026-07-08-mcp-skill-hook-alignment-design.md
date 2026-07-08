# MCP, Skill, and Hook Alignment Design

Date: 2026-07-08
Project: agent-team
Reference target: tui-code

## Goal

Align agent-team with tui-code for MCP, Skill, and Hook capabilities while preserving agent-team's current kernel, runtime, permission, and tool architecture.

The implementation order is:

1. MCP first.
2. Skill second.
3. Hooks after skill metadata boundaries are stable.

Plugin skills are explicitly out of scope.

## Confirmed Constraints

| Area | Decision |
|---|---|
| MCP phase one transports | stdio, streamable HTTP, SSE, WebSocket |
| Excluded from MCP phase one | claudeai-proxy, OAuth, authentication flows, MCP skills |
| MCP phase one capabilities | tools, resources, prompts |
| MCP tool exposure | ToolSearch plus deferred MCP tools |
| MCP config sources | user ~/.einsteins/mcp.json, project .mcp.json, agent-team.yaml mcpServers |
| MCP server precedence | agent-team.yaml, then project .mcp.json, then user ~/.einsteins/mcp.json |
| User settings directory | ~/.einsteins/settings.yaml |
| Legacy settings | ~/.agent-team/settings.yaml may be read as fallback only |
| Skill execution | inline and fork are both required |
| Skill sources | ~/.einsteins/skills, project .agents/skills, project .einsteins/skills, bundled skills, MCP skills |
| Excluded skill sources | plugin skills, remote canonical skills, marketplace |
| Hook scope | skill hooks plus a global hook runtime |
| Hook types | command, prompt, agent, http, function |
| Authentication | not implemented |

## Current Project Compared With tui-code

| Capability | agent-team today | tui-code style target | Gap |
|---|---|---|---|
| MCP config | lightweight in-memory MCP client and adapter | multi-source config, connection lifecycle, transports, resources, prompts, tools | agent-team lacks config merge, real transports, connection manager, resources, prompts |
| MCP tools | direct adapter from MCP tool to local Tool | ToolSearch and deferred MCP tool loading | agent-team exposes no deferred discovery layer |
| MCP resources | not implemented as runtime tools | list and read resource tools | missing resource tools and resource cache |
| MCP prompts | not implemented | prompt listing and execution | missing prompt adapter |
| Skill loader | prompt-only local SKILL.md loader | multi-source skill discovery, metadata, inline/fork, MCP skills, hooks | loader is too shallow |
| Skill execution | no dedicated skill runtime | SkillTool with inline and fork execution | missing execution semantics |
| Skill hooks | not implemented | skill frontmatter hooks become session hooks | missing hook schema and registration |
| Global hooks | no global hook runtime | settings, session, builtin, and skill hook execution | missing hook runtime and event integration |
| Architecture | existing kernel/runtime/tool registry is compact | tui-code has larger services with many UI/runtime integrations | should adapt concepts, not copy structure directly |

## Chosen Approach

Use a layered runtime design rather than direct tui-code file migration.

| Option | Description | Result |
|---|---|---|
| Minimal patch | Extend existing files directly | Rejected because MCP, Skill, and Hook concerns would become tangled |
| Layered runtime | Add McpRuntime, SkillRuntime, HookRuntime and connect them to current registries | Selected |
| Direct tui-code transplant | Copy large tui-code subsystems | Rejected because current model, permission, and tool protocols differ |

The selected design keeps agent-team's existing architecture and imports tui-code's behavior where it fits.

## Phase 0: Configuration Foundation

### User Directory

The canonical user directory is ~/.einsteins.

New defaults:

| File | Purpose |
|---|---|
| ~/.einsteins/settings.yaml | user settings |
| ~/.einsteins/mcp.json | user MCP servers |
| ~/.einsteins/skills | user skills |

The legacy ~/.agent-team/settings.yaml path is read only as a fallback when the new settings file does not exist. New writes and documentation use ~/.einsteins/settings.yaml only.

### MCP Config Merge

MCP servers are read from three sources:

1. User ~/.einsteins/mcp.json.
2. Project root .mcp.json.
3. Project agent-team.yaml under mcpServers.

Same-name server precedence is:

1. agent-team.yaml mcpServers.
2. Project .mcp.json.
3. User ~/.einsteins/mcp.json.

Different server names are merged.

### MCP Server Schema

Common fields:

| Field | Meaning |
|---|---|
| type | stdio, http, sse, or ws |
| disabled | disables the server without removing config |
| timeoutMs | connection and request timeout |

stdio fields:

| Field | Meaning |
|---|---|
| command | executable command |
| args | command arguments |
| env | process environment additions |
| cwd | working directory |

http, sse, and ws fields:

| Field | Meaning |
|---|---|
| url | endpoint URL |
| headers | optional static headers, not an authentication system |

OAuth, token refresh, needs-auth caches, and Claude.ai connector discovery are excluded.

## Phase 1: MCP Runtime

### Modules

| Module | Responsibility |
|---|---|
| src/mcp/schema.ts | MCP config schema |
| src/mcp/config.ts | load and merge MCP config sources |
| src/mcp/transports.ts | create stdio, http, sse, and ws transports |
| src/mcp/connectionManager.ts | maintain server lifecycle and capability caches |
| src/mcp/runtime.ts | facade used by tools and TUI |
| src/mcp/deferredTools.ts | ToolSearch plus deferred MCP tool exposure |
| src/mcp/resourceTools.ts | ListMcpResources and ReadMcpResource |
| src/mcp/promptTools.ts | list, get, and run MCP prompts |

### Connection Lifecycle

Each server has a state:

| State | Meaning |
|---|---|
| pending | connection requested or starting |
| connected | initialized and capabilities loaded |
| failed | connection failed, error stored for diagnostics |
| disabled | config disables the server |

One failed server does not block the rest of the application.

The manager refreshes tools, resources, and prompts after initialization and when list changed notifications arrive.

### Tool Exposure

The model sees stable discovery and resource tools by default:

| Tool | Purpose |
|---|---|
| ToolSearch | search local and MCP tools, including deferred MCP tools |
| ListMcpResources | list MCP resources by server or filter |
| ReadMcpResource | read one MCP resource |
| ListMcpPrompts | list MCP prompts |
| GetMcpPrompt | fetch MCP prompt definition and arguments |
| RunMcpPrompt | execute an MCP prompt with arguments |

MCP tool names use:

```text
mcp__{serverName}__{toolName}
```

MCP tools are deferred. They become visible only through search or explicit selection, preventing huge provider tool payloads.

### Resources

ListMcpResources accepts optional server and filter inputs.

ReadMcpResource accepts server and uri. Text content is returned directly with metadata. Binary content returns metadata and a clear unsupported-content message in phase one.

### Prompts

MCP prompts are not registered as slash commands in phase one. They are exposed through explicit tools first. This avoids coupling the MCP implementation to TUI command completion before the runtime is stable.

## Phase 2: Skill Runtime

### Sources

SkillRuntime scans:

1. Explicit project skill paths configured under agent-team.yaml.
2. Project .agents/skills.
3. Project .einsteins/skills.
4. User ~/.einsteins/skills.
5. Bundled skills.
6. MCP skills.

Plugin skills, marketplace, and remote canonical skills are excluded.

### Skill Format

SKILL.md remains the primary unit.

Frontmatter fields:

| Field | Meaning |
|---|---|
| name | skill name |
| description | short summary |
| when_to_use | routing guidance |
| allowed-tools | allowed or preferred tools |
| model | preferred model |
| effort | preferred reasoning effort |
| context | additional context policy |
| mode | inline, fork, or auto |
| hooks | skill-scoped hooks |
| paths | skill-associated paths |

Unknown fields are preserved in metadata rather than rejected.

### Inline Skill

Inline skill activation injects the SKILL.md body as a runtime attachment in the current session. It inherits the current permission context.

### Fork Skill

Fork skill activation creates a controlled child model loop, not an operating system process. The child loop uses the selected model and narrowed tools. It returns a summary or structured result to the parent session.

Fork skills may inherit or reduce permissions, but they must never expand permissions beyond the parent context.

### MCP Skills

MCP skills are implemented in the Skill phase, not MCP phase one. They adapt MCP-provided capabilities into LoadedSkill records and preserve source metadata.

## Phase 3: Hook Runtime

### Hook Sources

HookRuntime merges:

| Source | Persistence |
|---|---|
| user settings hooks | persistent |
| project settings hooks | persistent |
| session hooks | in-memory |
| skill hooks | session-scoped |
| builtin function hooks | in-memory |

Plugin hooks are excluded.

### Hook Types

| Type | Behavior |
|---|---|
| command | run a shell command with hook input JSON |
| prompt | run a structured model check |
| agent | run a constrained child agent verification loop |
| http | POST hook input JSON to a URL |
| function | internal callback only, not persisted in YAML |

### Initial Wired Events

The first wired events are:

| Event | Behavior |
|---|---|
| UserPromptSubmit | can block or add context before model request |
| PreToolUse | can block, allow, ask, or update tool input |
| PostToolUse | can add context after successful tool execution |
| PostToolUseFailure | can add diagnostics after failed tool execution |
| Stop | can block turn completion and force continuation |

The type layer reserves the broader tui-code event set. Events not wired yet are accepted in configuration but reported as not wired in diagnostics.

### Hook Matching

An empty matcher matches all.

For tool events, matcher applies to tool_name.

For prompt or message events, matcher applies to prompt, message, reason, or event name depending on available input.

The if field supports ToolName(pattern) style filtering.

### Command Hook Semantics

Hook input JSON is provided through stdin and an environment variable.

stdout may contain a JSON response.

Exit codes:

| Exit code | Meaning |
|---|---|
| 0 | success |
| 2 | blocking error |
| other non-zero | non-blocking error |

timeout, async, and once are supported.

### Prompt and Agent Hook Semantics

Prompt hooks ask the model for structured JSON:

```json
{"ok": true}
```

or:

```json
{"ok": false, "reason": "reason"}
```

Agent hooks use a constrained child loop and must return the same structure.

### HTTP Hook Semantics

HTTP hooks POST hook input JSON. Static headers may be supplied, but no authentication flow, OAuth, token refresh, or secret interpolation is implemented in this phase.

### Skill Hooks

When a skill is activated, hooks from its frontmatter are registered as session-scoped hooks. once hooks are removed after first successful execution. Skill hooks are cleaned when their session ends.

## Phase 4: TUI and Diagnostics

TUI diagnostics should show:

| Area | Diagnostic |
|---|---|
| MCP | server state, connection errors, tool/resource/prompt counts |
| Deferred tools | search hits and selected MCP tools |
| Skills | source, activation mode, metadata |
| Hooks | configured hooks, source, wired or not wired, last execution summary |

This phase is after runtime behavior is correct.

## Error Handling

| Area | Behavior |
|---|---|
| MCP server failure | mark only that server failed |
| MCP tool failure | return model-readable tool error |
| Resource read failure | return model-readable error with server and uri |
| Prompt fetch failure | return model-readable error |
| Skill parse failure | isolate the failed skill and report diagnostics |
| Fork skill failure | return structured failure to parent |
| Hook failure | command/http/model failures default to non-blocking unless semantics explicitly block |
| Hook timeout | cancel the hook and report non-blocking error unless blocking semantics apply |

## Testing Strategy

Testing must avoid hangs and external dependencies.

| Area | Test Approach |
|---|---|
| MCP config | pure unit tests for merge and precedence |
| MCP transports | fake transport factory and fake MCP server/client |
| MCP tools | fake runtime-backed deferred tool tests |
| Resources | fake resource cache and read results |
| Prompts | fake prompt cache and execution result tests |
| Skills | temp directories with SKILL.md files |
| Fork skills | fake provider and constrained child session |
| Hooks | fake command executor, fake provider, fake HTTP executor |
| Integration | targeted runtime and query engine tests with explicit timeouts |

Full test runs are optional. Targeted tests are preferred unless shared contracts change broadly.

## Implementation Order

1. Add config schemas and ~/.einsteins settings path fallback behavior.
2. Add MCP config source loading and precedence tests.
3. Add MCP connection manager and transport factory with fake-client tests.
4. Add ToolSearch and deferred MCP tool adapter.
5. Add resource and prompt MCP tools.
6. Add SkillRuntime discovery and metadata parser.
7. Add inline skill execution.
8. Add fork skill execution.
9. Add MCP skill adapter.
10. Add HookRuntime types and execution engine.
11. Add core hook event integration.
12. Add skill hook registration.
13. Add TUI diagnostics.

## Non-Goals

The following are intentionally excluded:

| Non-goal | Reason |
|---|---|
| claudeai-proxy | explicitly removed from phase one |
| OAuth or authentication | user confirmed no authentication |
| plugin skill | explicitly out of scope |
| plugin hooks | out of scope with plugin skill |
| marketplace | out of scope |
| remote canonical skills | out of scope |
| registering MCP prompts as slash commands in phase one | deferred to avoid coupling MCP runtime to TUI command system |

## Acceptance Criteria

Phase one MCP is complete when:

1. stdio, http, sse, and ws MCP server configs are accepted.
2. user, project, and agent-team.yaml mcpServers merge with the confirmed precedence.
3. tools, resources, and prompts are cached per connected server.
4. ToolSearch can discover deferred MCP tools.
5. selected MCP tools can be invoked by mcp__server__tool name.
6. resources can be listed and text resources can be read.
7. prompts can be listed and fetched or run through explicit tools.
8. one failed server does not block other servers or local tools.

Skill runtime is complete when:

1. all confirmed non-plugin skill sources are scanned.
2. same-name skill precedence is deterministic.
3. inline and fork execution both work.
4. fork execution cannot expand permissions.
5. MCP skills are adapted in the Skill phase.

Hook runtime is complete when:

1. settings, session, skill, and builtin function hooks can be registered.
2. command, prompt, agent, http, and function hook types can execute through testable executors.
3. UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, and Stop are wired.
4. blocking, context injection, and updated tool input semantics are tested.
5. tests use fakes by default to avoid shell, network, or model hangs.

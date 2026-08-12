# agent-team

A local TUI harness for configurable workflow and dynamically routed team sessions.

## Quick Start

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Open the TUI: `node dist/cli/main.js`
4. Edit the generated `~/.einsteins/settings.json` and set `api_key` for the providers you use
5. Customize user-level roles, workflows, and teams under `~/.einsteins/roles`, `~/.einsteins/workflows`, and `~/.einsteins/teams`

## Provider Configuration

The first TUI startup creates `~/.einsteins/settings.json` when it does not exist. The generated file contains only compact Responses API and Anthropic provider definitions under its top-level `providers` key. Existing settings files are never overwritten. Settings changed later through the TUI, such as permissions and status-line elements, are added to the same file without expanding omitted provider defaults.

A provider normally needs only four fields:

```json
{
  "providers": {
    "default": {
      "type": "responses-api",
      "base_url": "https://api.openai.com/v1",
      "api_key": "",
      "default_model": "gpt-5.5"
    }
  }
}
```

Advanced fields remain optional. Explicit values override runtime defaults. Responses API and Anthropic providers default to tool calling, vision, streaming, and JSON-schema output support. Provider-level `effort` accepts any non-empty string and defaults to `medium`; a workflow node may override it with its own `effort`.

Each provider also supports the same retry and timeout controls:

```json
{
  "providers": {
    "default": {
      "request_max_retries": 10,
      "stream_max_retries": 10,
      "request_timeout_ms": 600000,
      "stream_idle_timeout_ms": 90000
    }
  }
}
```

`request_max_retries` applies before a streaming response is established and to non-streaming requests. `stream_max_retries` applies after streaming begins, including premature EOF, interrupted sockets, invalid completion markers, and idle streams. A value of `0` disables the corresponding retries. Retries cover network and timeout failures, HTTP 408, 409, 429, retryable 424 dependency failures, and 5xx responses. Authentication, permission, ordinary 4xx, context-limit, and user-cancellation errors are not retried.

Backoff starts at 500 ms, doubles up to 32 seconds, and adds 0-25% jitter; a valid `Retry-After` response header takes precedence. Streaming never falls back to non-streaming mode, so a retry cannot cause completed tool calls to be replayed through a second response path. Every scheduled retry is persisted in `events.ndjson` and the session `audit.ndjson`. The TUI shows one temporary reconnect status, updates it across consecutive retries, rolls back failed stream fragments, and removes it after success, failure, interruption, or cancellation.

Roles, workflows, and teams are user-level configuration under `~/.einsteins/roles`, `~/.einsteins/workflows`, and `~/.einsteins/teams`. On startup, missing directories are initialized from the application's bundled `config/` templates without merging into or overwriting existing directories. Provider definitions remain in user settings, and API key environment variables are not supported.

An empty `api_key` in the generated template does not block startup. The application reports an error only when a workflow tries to use that provider.

## MCP Configuration

User MCP servers are configured under the top-level `mcpServers` key in `~/.einsteins/settings.json`. Project MCP servers use `<project>/.einsteins/settings.json`; same-name project servers override user servers. Managed MCP configuration remains exclusive when present.

MCP values support `${ENV_VAR}` expansion at runtime. Keep credentials as environment references so `/mcp enable|disable` can update local project overrides without writing resolved secrets back to disk. Legacy `~/.einsteins.json` and project `.mcp.json` files are not read.

## User Roles, Workflows, and Teams

Runtime configuration has this layout:

```text
~/.einsteins/
  settings.json       # providers, user MCP, and local project MCP overrides
  history.jsonl       # project-scoped prompt input history
  roles/
    bus.md             # optional session bus strategy
    developer.md
  workflows/
    delivery.json
  teams/
    team.json
  AGENTS.md
  skills/
    reviewer/
      SKILL.md
~/.agents/skills/     # legacy user-skill fallback only
<application-root>/config/
  prompt.md
  roles/              # initialization templates
  workflows/          # initialization templates
  teams/              # initialization templates
<project>/.einsteins/
  settings.json       # project settings and project MCP
  AGENTS.md
  skills/
    reviewer/
      SKILL.md
```

The runtime never reads roles, workflows, or teams from the current project's `config/` directory. Missing user-level directories are initialized atomically from the bundled templates; existing `roles`, `workflows`, or `teams` directories are never merged with or overwritten. The bundled `config/prompt.md` contains mandatory system instructions prepended to every role prompt. The optional reserved `bus` role is loaded automatically by the session execution bus and does not need to appear in workflow or team `nodes`; when it is absent, the built-in routing protocol remains unchanged. Because existing role directories are not merged, existing users must add `~/.einsteins/roles/bus.md` themselves to opt into the bundled bus strategy.

Project-specific instructions may be added in `.einsteins/AGENTS.md`; they supplement but cannot override the bundled prompt or active role prompt. Skill precedence is nearest project `.einsteins/skills`, user `~/.einsteins/skills`, then legacy user `~/.agents/skills`. Project `.agents` directories are not read. Each role Markdown file uses `SKILL.md`-style YAML frontmatter with `name` and `description`; its body is the role system prompt.

Each workflow or team JSON file contains `name`, `nodes`, optional `description`, optional `max_rework_cycles` (default `99`), optional `dispatcher`, and optional `permissions`. The removed `workflow_permissions` field is rejected. Empty or omitted descriptions are not shown in the TUI, and neither file type accepts an `edges` field. Workflows follow node order. Teams treat `nodes` as the available member set: after every node success or failure, control returns to the bus, which dynamically selects the next node or finalizes the task.

## Interactive TUI

Every `agent-team` invocation opens the interactive terminal UI. Former headless subcommands such as `run`, `resume`, `status`, and `inspect` are routed into the TUI instead of executing automation directly.

The TUI reads roles, workflows, and teams from `~/.einsteins` and opens with a half-screen workflow/team picker directly below the preview chart. Workflow and team entries are shown at the same level with their type, so identical names remain unambiguous. Moving through the list previews the selected nodes; team previews omit node-to-node arrows. The final disabled `Create new workflow` and `Create new team` items reserve future creation flows. The current directory does not need a `config/` directory.

Submitted prompts are appended to `~/.einsteins/history.jsonl` and recalled across TUI sessions for the same Git project. Up/Down navigate logical lines inside multiline input before entering history navigation. Wrapped and explicit input lines remain visible up to a half-screen viewport. Use Shift+Enter or Ctrl+Enter to insert a newline. On Apple Terminal, run `/terminal-setup`, restart Terminal.app, and use Option+Enter.

`/resume` lists resumable sessions rather than individual historical runs. Press `Ctrl+X` on the focused session to open a confirmation dialog; confirmed sessions are moved intact to the project's `.trash/sessions` storage and disappear from the picker. The session currently referenced by the TUI cannot be archived.

Text selections are copied to the clipboard when selection finishes while the highlight remains visible. Set the top-level `copyOnSelect` setting to `false` to disable this behavior. `Ctrl+C`, `Ctrl+Shift+C`, or a terminal-reported `Cmd+C` copies and clears an active selection; terminals such as Apple Terminal consume `Cmd+C` before the TUI can observe it.

The `/permissions` menu persists the selected default execution mode to `~/.einsteins/settings.json`. New TUI sessions read that value during startup. A project-level `.einsteins/settings.json` can still override the user default for that project.

## Test Progress

`npm test` runs test files sequentially and reports the current file, completed file count, per-file duration, and final test totals. A test file that runs longer than 10 seconds emits a periodic `RUNNING` heartbeat, making stalled files visible.

```text
[test] [12/71] START tests/tui/components.test.js
[test] [12/71] RUNNING tests/tui/components.test.js (10.00s)
[test] [12/71] PASS tests/tui/components.test.js (18.42s)
```

Pass source test paths after `--` to run a focused subset while keeping the same progress output:

```sh
npm test -- tests/config/loadConfig.test.ts tests/settings/settings.test.ts
```

## Workflow Ordering and Team Routing

Workflow nodes run in the order listed under `nodes`. Team nodes do not run sequentially: the bus assigns one member at a time and reevaluates the complete run dossier after every node boundary until it chooses to finalize.

Each node receives descriptors for its current, previous, and next workflow positions. A node submits the explicit direction `forward` or `backward`: `forward` advances or resumes the suspended downstream node, while `backward` suspends the current node and resumes the previous node in the same attempt. Every reactivation increments an auditable activation number. Only the first node can move backward to the user; the final node moves forward to the user to complete the run.

The bundled `delivery` workflow is `product -> ui -> developer -> tester`. All nodes use the `default` provider, and `tester` is the complete node that produces the final verification report.

Workflow session control in the TUI:

- The first ordinary prompt in a fresh TUI session starts the selected workflow.
- When a workflow stops with a saved resume checkpoint, the TUI enters `paused`; the next ordinary prompt continues from that checkpoint node. Completed or non-recoverable failed workflows continue as a new cycle in the same session and the same run; only `/new` creates a new session and run.
- Use `/new` only when you explicitly want to reset the TUI session and start over.
- Use `/resume [run_id]` to restore a historical session's state, conversation, and logs. Restoring does not automatically continue that workflow; submit a normal prompt after restore to continue.
- Slash command suggestions appear above the input line. Press `Esc` to dismiss an open suggestion or active choice without selecting it.

## Safety Model

The harness follows Claude Code-style local tool execution and permissions where practical. Workflow-level deny rules are baseline restrictions. Node-level permissions grant role-specific access. Workflow state uses V2 crash-recoverable primary/backup checkpoints. A per-run process lease prevents concurrent engines from advancing the same run, workflow and role fingerprints reject unsafe resumes after configuration drift, and the tool event ledger prevents automatic replay of non-read-only calls with unknown outcomes. Artifact writes create immutable revisions with SHA-256 indexes instead of overwriting earlier handoff files.

## 中文说明

`agent-team` 是一个本地 TUI 版 Agent 团队编排 Harness。Provider 和 API 密钥统一配置在用户目录的 `~/.einsteins/settings.json`；首次生成的文件只包含精简的 Responses API 与 Anthropic Provider 节点，高级字段省略时使用运行时默认值，用户显式填写时覆盖默认值。权限、状态栏等通过 TUI 修改的设置会追加到同一文件，并且不会展开未填写的 Provider 默认字段。角色和工作流分别从 `~/.einsteins/roles`、`~/.einsteins/workflows` 读取；目录缺失时从应用内置 `config/` 模板初始化，已有目录不会被合并或覆盖。必须遵循的系统提示词固定读取应用内置 `config/prompt.md`。项目自定义提示词与 Skill 分别放在 `.einsteins/AGENTS.md` 和 `.einsteins/skills`，用户级 MCP 与项目级 MCP 分别配置在各自的 `.einsteins/settings.json` 中。系统按 `nodes` 顺序执行模型调用和本地工具调用。会话数据统一保存在 `~/.einsteins/projects/{转义后的项目路径}/{sessionId}`：`session.json`、`transcript.jsonl` 与 `audit.ndjson` 属于 Session，单次执行数据位于 `runs/{runId}` 下的 `run.json`、`state.json`、`events.ndjson` 和 `artifacts`。Session 与 Run 标识不再包含日期前缀，也不再按月份分层。

MVP 支持：

- Responses API、OpenAI-compatible 和 Anthropic Provider
- 三类 Provider 统一支持请求错误、请求超时、流中断、提前 EOF 和流空闲超时重试；默认请求与流各重试 10 次，请求超时 600 秒，流空闲超时 90 秒
- 重试采用 500ms 指数退避、32 秒上限和 0-25% 抖动，并优先遵循 `Retry-After`；认证、权限、普通 4xx、上下文超限和用户取消不会重试
- TUI 连续重试只更新一条临时重连状态，失败流残片会回滚，终态后自动移除；完整记录持久化到 `events.ndjson` 与 Session `audit.ndjson`
- Claude Code 风格 `allow`、`ask`、`deny` 权限规则
- 本地工具集：`Read`、`Write`、`Edit`、`MultiEdit`、`LS`、`Glob`、`Grep`、`Bash`、`PowerShell`、`ProcessStart`、`ProcessStatus`、`ProcessStop`、`TodoWrite`、`AttachImage`、`WebFetch`、`WebSearch`
- 长时间运行的本地进程必须通过 `ProcessStart` 启动，并使用 `ProcessStatus`、`ProcessStop` 管理；节点完成、失败或中断时会自动回收。Bash `&`、PowerShell `Start-Process` 等非托管后台启动会被拒绝。
- 默认按 `nodes` 顺序执行，节点必须显式提交 `forward`、`backward` 或 `retry`；退回节点与上游节点保持原 attempt，并以新的 activation 从对话检查点继续
- 只有首节点可以 `backward` 到用户；用户回答后首节点原位继续，末节点 `forward` 到用户后完成工作流
- 默认 `delivery` 为 `product -> ui -> developer -> tester`，全部使用 `default` Provider，tester 兼任最终交付
- 默认最多执行 99 次节点间退回或原节点重试，达到上限后由控制器暂停并请求用户决定
- TUI session 状态控制：首次普通输入启动当前工作流；存在恢复检查点时，停止后进入 `paused`，后续普通输入从检查点节点继续；已完成或不可恢复失败后则在同一 session、同一 run 中开启新一轮；只有 `/new` 创建新的 session 和 run，`/resume [run_id]` 仅恢复历史状态
- 图片 artifact 输入和 vision capability 检查
- 同名 artifact 使用不可变 revision 和 SHA-256 索引，旧版本不会被覆盖
- 同一 run 使用跨进程排他租约；恢复时校验工作流与角色配置指纹，并通过工具调用账本避免重复执行结果不明的非只读操作
- `state.json` 和 artifact 索引使用主副本崩溃恢复写入，Windows 下不会因 rename 失败退化为无保护覆盖

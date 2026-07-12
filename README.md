# agent-team

A local TUI harness for configurable agent-team workflow sessions.

## Quick Start

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Create or edit the project `config/` directory
4. Open the TUI: `node dist/cli/main.js`
5. Edit the generated `~/.einsteins/settings.yaml` and set `api_key` for the providers you use

## Provider Configuration

The first TUI startup creates `~/.einsteins/settings.yaml` when it does not exist. Provider definitions and API keys are user-level settings and must be configured under its top-level `providers` key. Existing settings files are never overwritten.

Project roles and workflows live under `config/`. Provider definitions are not supported in project configuration. API key environment variables are not supported.

An empty `api_key` in the generated template does not block startup. The application reports an error only when a workflow tries to use that provider.

## Project Configuration

The project configuration has a fixed layout:

```text
config/
  prompt.md
  roles/
    developer.md
  workflows/
    delivery.json
.agents/
  AGENTS.md
  skills/
    reviewer/
      SKILL.md
```

`config/prompt.md` contains mandatory system instructions prepended to every role prompt. Project-specific user instructions may be added in `.agents/AGENTS.md`; they supplement but cannot override `config/prompt.md` or the active role prompt. Project skills are discovered from `.agents/skills/<name>/SKILL.md`, while user instructions and skills remain under `~/.einsteins/AGENTS.md` and `~/.einsteins/skills`. Project skills override same-name user skills. Each role Markdown file uses `SKILL.md`-style YAML frontmatter with `name` and `description`; its body is the role system prompt. Role tool-calling and vision requirements are always enabled by the runtime.

Each workflow JSON file contains `name`, `nodes`, and optional `workflow_permissions`. Workflows follow node order, so workflow files do not accept an `edges` field.

## Interactive TUI

Every `agent-team` invocation opens the interactive terminal UI. Former headless subcommands such as `run`, `resume`, `status`, and `inspect` are routed into the TUI instead of executing automation directly.

The TUI reads `config/` from the current directory, selects workflow `delivery` when present, and lets you work in a reusable session with live node, tool, permission, log, and result status.

The `/permissions` menu persists the selected default execution mode to `~/.einsteins/settings.yaml`. New TUI sessions read that value during startup. A project-level `.einsteins/settings.yaml` can still override the user default for that project.

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

## Workflow Ordering

Workflow nodes run in the order listed under `nodes`.

When a node returns `success`, the workflow advances to the next node. When a node returns `failure`, the workflow returns to the previous node for rework. When a node returns `needs_user_input`, the workflow pauses and asks the user for the requested input.

Workflow session control in the TUI:

- The first ordinary prompt in a fresh TUI session starts the selected workflow.
- When a workflow stops with a saved resume checkpoint, the TUI enters `paused`; the next ordinary prompt continues from that checkpoint node. Completed or non-recoverable failed workflows still start a new turn in the same session.
- Use `/new` only when you explicitly want to reset the TUI session and start over.
- Use `/resume [run_id]` to restore a historical session's state, conversation, and logs. Restoring does not automatically continue that workflow; submit a normal prompt after restore to continue.
- Slash command suggestions appear above the input line. Press `Esc` to dismiss an open suggestion or active choice without selecting it.

## Safety Model

The harness follows Claude Code-style local tool execution and permissions where practical. Workflow-level deny rules are baseline restrictions. Node-level permissions grant role-specific access. MVP node completion is model-declared; downstream nodes and user acceptance can reject completion and trigger feedback loops.

## 中文说明

`agent-team` 是一个本地 TUI 版 Agent 团队编排 Harness。Provider 和 API 密钥统一配置在用户目录的 `~/.einsteins/settings.yaml`；项目目录的 `config/roles`、`config/workflows` 和 `config/prompt.md` 分别配置角色、工作流和必须遵循的系统提示词。项目自定义提示词与 Skill 分别放在 `.agents/AGENTS.md` 和 `.agents/skills`，用户级内容继续放在 `~/.einsteins`。系统按 `nodes` 顺序执行模型调用和本地工具调用，并把每次会话记录到 `.session/{run_id}`。

MVP 支持：

- Responses API、OpenAI-compatible 和 Anthropic Provider
- Claude Code 风格 `allow`、`ask`、`deny` 权限规则
- 本地工具集：`Read`、`Write`、`Edit`、`MultiEdit`、`LS`、`Glob`、`Grep`、`Bash`、`PowerShell`、`TodoWrite`、`AttachImage`、`WebFetch`、`WebSearch`
- 默认按 `nodes` 顺序执行，`success` 进入下一节点，`failure` 返回上一节点返工，`needs_user_input` 暂停交给用户处理
- `waiting_user` 暂停与 TUI 内继续
- TUI session 状态控制：首次普通输入启动当前工作流；存在恢复检查点时，停止后进入 `paused`，后续普通输入从检查点节点继续；已完成或不可恢复失败后则作为同一 session 的新一轮；`/new` 显式重置，`/resume [run_id]` 仅恢复历史状态
- 图片 artifact 输入和 vision capability 检查
- `final_delivery` 普通节点式最终交付

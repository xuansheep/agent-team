# agent-team

A local TUI harness for configurable agent-team workflow sessions.

## Quick Start

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Open the TUI: `node dist/cli/main.js`
4. Edit the generated `~/.einsteins/settings.json` and set `api_key` for the providers you use
5. Customize user-level roles and workflows under `~/.einsteins/roles` and `~/.einsteins/workflows`

## Provider Configuration

The first TUI startup creates `~/.einsteins/settings.json` when it does not exist. Provider definitions and API keys are user-level settings and must be configured under its top-level `providers` key. Existing settings files are never overwritten.
Provider-level `effort` accepts any non-empty string and defaults to `medium`; a workflow node may override it with its own `effort`.

Roles and workflows are user-level configuration under `~/.einsteins/roles` and `~/.einsteins/workflows`. On startup, missing directories are initialized from the application's bundled `config/` templates without merging into or overwriting existing directories. Provider definitions remain in user settings, and API key environment variables are not supported.

An empty `api_key` in the generated template does not block startup. The application reports an error only when a workflow tries to use that provider.

## User Roles and Workflows

Runtime configuration has this layout:

```text
~/.einsteins/
  settings.json
  roles/
    developer.md
  workflows/
    delivery.json
  AGENTS.md
<application-root>/config/
  prompt.md
  roles/       # initialization templates
  workflows/   # initialization templates
<project>/.agents/
  AGENTS.md
  skills/
    reviewer/
      SKILL.md
```

The runtime never reads roles or workflows from the current project's `config/` directory. Missing user-level directories are initialized atomically from the bundled templates; an existing `roles` or `workflows` directory is never merged with or overwritten. The bundled `config/prompt.md` contains mandatory system instructions prepended to every role prompt.

Project-specific instructions may be added in `.agents/AGENTS.md`; they supplement but cannot override the bundled prompt or active role prompt. Project skills are discovered from `.agents/skills/<name>/SKILL.md`, while user instructions and skills remain under `~/.einsteins/AGENTS.md` and `~/.einsteins/skills`. Project skills override same-name user skills. Each role Markdown file uses `SKILL.md`-style YAML frontmatter with `name` and `description`; its body is the role system prompt.

Each workflow JSON file contains `name`, `nodes`, optional `max_rework_cycles` (default `10`), and optional `workflow_permissions`. Workflows follow node order, so workflow files do not accept an `edges` field.

## Interactive TUI

Every `agent-team` invocation opens the interactive terminal UI. Former headless subcommands such as `run`, `resume`, `status`, and `inspect` are routed into the TUI instead of executing automation directly.

The TUI reads roles and workflows from `~/.einsteins`, selects workflow `delivery` when present, and lets you work in a reusable session with live node, tool, permission, log, and result status. The current directory does not need a `config/` directory.

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

## Workflow Ordering

Workflow nodes run in the order listed under `nodes`.

Each node receives descriptors for its current, previous, and next workflow positions. A node submits the explicit direction `forward` or `backward`: `forward` advances or resumes the suspended downstream node, while `backward` suspends the current node and resumes the previous node in the same attempt. Every reactivation increments an auditable activation number. Only the first node can move backward to the user; the final node moves forward to the user to complete the run.

The bundled `delivery` workflow is `product -> ui -> developer -> tester`. All nodes use the `default` provider, and `tester` is the complete node that produces the final verification report.

Workflow session control in the TUI:

- The first ordinary prompt in a fresh TUI session starts the selected workflow.
- When a workflow stops with a saved resume checkpoint, the TUI enters `paused`; the next ordinary prompt continues from that checkpoint node. Completed or non-recoverable failed workflows still start a new turn in the same session.
- Use `/new` only when you explicitly want to reset the TUI session and start over.
- Use `/resume [run_id]` to restore a historical session's state, conversation, and logs. Restoring does not automatically continue that workflow; submit a normal prompt after restore to continue.
- Slash command suggestions appear above the input line. Press `Esc` to dismiss an open suggestion or active choice without selecting it.

## Safety Model

The harness follows Claude Code-style local tool execution and permissions where practical. Workflow-level deny rules are baseline restrictions. Node-level permissions grant role-specific access. Workflow state uses V2 crash-recoverable primary/backup checkpoints. A per-run process lease prevents concurrent engines from advancing the same run, workflow and role fingerprints reject unsafe resumes after configuration drift, and the tool event ledger prevents automatic replay of non-read-only calls with unknown outcomes. Artifact writes create immutable revisions with SHA-256 indexes instead of overwriting earlier handoff files.

## 中文说明

`agent-team` 是一个本地 TUI 版 Agent 团队编排 Harness。Provider 和 API 密钥统一配置在用户目录的 `~/.einsteins/settings.json`，角色和工作流分别从 `~/.einsteins/roles`、`~/.einsteins/workflows` 读取；目录缺失时从应用内置 `config/` 模板初始化，已有目录不会被合并或覆盖。必须遵循的系统提示词固定读取应用内置 `config/prompt.md`。项目自定义提示词与 Skill 分别放在 `.agents/AGENTS.md` 和 `.agents/skills`。系统按 `nodes` 顺序执行模型调用和本地工具调用，并把每次会话记录到 `.session/{run_id}`。

MVP 支持：

- Responses API、OpenAI-compatible 和 Anthropic Provider
- Claude Code 风格 `allow`、`ask`、`deny` 权限规则
- 本地工具集：`Read`、`Write`、`Edit`、`MultiEdit`、`LS`、`Glob`、`Grep`、`Bash`、`PowerShell`、`TodoWrite`、`AttachImage`、`WebFetch`、`WebSearch`
- 默认按 `nodes` 顺序执行，节点必须显式提交 `forward` 或 `backward`；退回节点与上游节点保持原 attempt，并以新的 activation 从对话检查点继续
- 只有首节点可以 `backward` 到用户；用户回答后首节点原位继续，末节点 `forward` 到用户后完成工作流
- 默认 `delivery` 为 `product -> ui -> developer -> tester`，全部使用 `default` Provider，tester 兼任最终交付
- 默认最多执行 10 次节点间退回，达到上限后由控制器暂停并请求用户决定
- TUI session 状态控制：首次普通输入启动当前工作流；存在恢复检查点时，停止后进入 `paused`，后续普通输入从检查点节点继续；已完成或不可恢复失败后则作为同一 session 的新一轮；`/new` 显式重置，`/resume [run_id]` 仅恢复历史状态
- 图片 artifact 输入和 vision capability 检查
- 同名 artifact 使用不可变 revision 和 SHA-256 索引，旧版本不会被覆盖
- 同一 run 使用跨进程排他租约；恢复时校验工作流与角色配置指纹，并通过工具调用账本避免重复执行结果不明的非只读操作
- `state.json` 和 artifact 索引使用主副本崩溃恢复写入，Windows 下不会因 rename 失败退化为无保护覆盖

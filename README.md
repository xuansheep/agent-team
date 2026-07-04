# agent-team

A local TUI harness for configurable agent-team workflow sessions.

## Quick Start

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Create or edit `agent-team.yaml` in the current directory
4. Set provider key: `OPENAI_API_KEY=...`
5. Open the TUI: `node dist/cli/main.js`

## Global Prompt File

Set `global_prompt_file` in `agent-team.yaml` to load shared instructions from a file. The path is resolved relative to the config file, and the loaded text is prepended to every role `system_prompt`.

```yaml
global_prompt_file: agent-team.global.md
```

## Interactive TUI

Every `agent-team` invocation opens the interactive terminal UI. Former headless subcommands such as `run`, `resume`, `status`, and `inspect` are routed into the TUI instead of executing automation directly.

The TUI reads `agent-team.yaml` from the current directory, selects workflow `delivery` when present, and lets you work in a reusable session with live node, tool, permission, log, and result status.

## Workflow Ordering

Workflow nodes run in the order listed under `nodes` by default. You do not need to configure `edges` for the common linear case.

When a node returns `success`, the workflow advances to the next node. When a node returns `failure`, the workflow returns to the previous node for rework. When a node returns `needs_user_input`, the workflow pauses and asks the user for the requested input.

Use `edges` only when a workflow needs custom routing that is not expressible by the node order. Explicit `edges` take precedence over the default ordered routing.

Workflow session control in the TUI:

- The first ordinary prompt in a fresh TUI session starts the selected workflow.
- When a workflow stops with a saved resume checkpoint, the TUI enters `paused`; the next ordinary prompt continues from that checkpoint node. Completed or non-recoverable failed workflows still start a new turn in the same session.
- Use `/new` only when you explicitly want to reset the TUI session and start over.
- Use `/resume [run_id]` to restore a historical session's state, conversation, and logs. Restoring does not automatically continue that workflow; submit a normal prompt after restore to continue.
- Slash command suggestions appear above the input line. Press `Esc` to dismiss an open suggestion or active choice without selecting it.

## Safety Model

The harness follows Claude Code-style local tool execution and permissions where practical. Workflow-level deny rules are baseline restrictions. Node-level permissions grant role-specific access. MVP node completion is model-declared; downstream nodes and user acceptance can reject completion and trigger feedback loops.

## 中文说明

`agent-team` 是一个本地 TUI 版 Agent 团队编排 Harness。它通过 `agent-team.yaml` 配置 provider、role、workflow node 和权限，默认按 `nodes` 顺序执行模型调用和本地工具调用，并把每次会话记录到 `.session/{run_id}`。

MVP 支持：

- OpenAI-compatible Provider
- Claude Code 风格 `allow`、`ask`、`deny` 权限规则
- 本地工具集：`Read`、`Write`、`Edit`、`MultiEdit`、`LS`、`Glob`、`Grep`、`Bash`、`PowerShell`、`TodoWrite`、`AttachImage`、`WebFetch`、`WebSearch`
- 默认按 `nodes` 顺序执行，`success` 进入下一节点，`failure` 返回上一节点返工，`needs_user_input` 暂停交给用户处理
- 可选 `edges` 自定义特殊流程
- `waiting_user` 暂停与 TUI 内继续
- TUI session 状态控制：首次普通输入启动当前工作流；存在恢复检查点时，停止后进入 `paused`，后续普通输入从检查点节点继续；已完成或不可恢复失败后则作为同一 session 的新一轮；`/new` 显式重置，`/resume [run_id]` 仅恢复历史状态
- 图片 artifact 输入和 vision capability 检查
- `final_delivery` 普通节点式最终交付

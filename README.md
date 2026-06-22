# agent-team

A local CLI harness for configurable agent-team workflows.

## Quick Start

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Create config: `node dist/cli/main.js init`
4. Set provider key: `OPENAI_API_KEY=...`
5. Run: `node dist/cli/main.js run -f agent-team.yaml --input "Build the requested feature"`

## Safety Model

The harness follows Claude Code-style local tool execution and permissions where practical. Workflow-level deny rules are baseline restrictions. Node-level permissions grant role-specific access. MVP node completion is model-declared; downstream nodes and user acceptance can reject completion and trigger feedback loops.

## 中文说明

`agent-team` 是一个本地 CLI 版 Agent 团队编排 Harness。它通过 `agent-team.yaml` 配置 provider、role、workflow node、权限和流程边，按节点执行模型调用和本地工具调用，并把每次运行记录到 `.runs/{run_id}`。

MVP 支持：

- OpenAI-compatible Provider
- Claude Code 风格 `allow`、`ask`、`deny` 权限规则
- 本地工具集：`Read`、`Write`、`Edit`、`MultiEdit`、`LS`、`Glob`、`Grep`、`Bash`、`PowerShell`、`TodoWrite`、`AttachImage`、`WebFetch`、`WebSearch`
- 线性主流程和失败返工边
- `waiting_user` 暂停与 `resume`
- 图片 artifact 输入和 vision capability 检查
- `final_delivery` 普通节点式最终交付

# Tui-Code Replication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` only when the active skill gate allows it. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `agent-team` 在排除 TUI 日志系统和远程能力实现的前提下，分阶段对齐 `tui-code` 的核心运行时、权限、工具、会话、Plan Mode、插件、任务和本地 headless 能力。

**Architecture:** 采用分阶段行为兼容，而不是一次性源码同构替换。保留当前 `workflow / harness / tui` 可运行边界，先抽出 conversation-first runtime 和统一工具权限契约，再让 workflow 成为 runtime 的一个 adapter。任何高风险能力，例如 shell、文件写入、SDK、MCP、插件和任务编排，都必须先有测试和本地审计事件。

**Tech Stack:** TypeScript ESM、React/Ink、Zod、Node.js、当前项目 `npm run build` / `npm test` 测试链路。

---

## 0. 当前判断

`agent-team` 当前是 workflow-first harness：`src/workflow` 负责节点流转，`src/harness` 负责单节点模型和工具循环，`src/tools` 是固定本地工具集，`src/storage` 用 `.session/{run_id}` 保存 run state/events，`src/tui` 展示交互。

`tui-code` 是 conversation-first CLI 产品：核心能力分布在 `QueryEngine.ts`、`query.ts`、`Tool.ts`、`tools/`、`utils/messages.ts`、`utils/attachments.ts`、`utils/permissions/`、`utils/plans.ts`、`commands/`、`services/mcp/`、`plugins/`、`tasks/`、`bridge/`、`entrypoints/sdk/`。

当前项目的 `node.mode === "plan"` 只是 workflow 内部的审核暂停点；`tui-code` 的 Plan Mode 是全局 `permissionMode: "plan"`，会改变可用工具、安全边界、上下文附件、计划文件和退出审批语义。后续实现时必须避免把当前 plan 节点误当成安全模式。

本计划不复刻 TUI 日志系统，不引入外发 telemetry，不实现远程能力。生产需要的是本地审计和可恢复执行，不是默认外发遥测或外部控制面。

## 1. 总体执行原则

- [ ] 每个 phase 必须能独立通过 `npm run build` 和相关测试。
- [ ] 每个行为变更先写测试，再改实现；测试必须覆盖失败路径。
- [ ] 不删除现有 workflow 能力；新 runtime 先并行接入，再逐步收敛。
- [ ] Plan Mode 必须是流程前安全模式：用户未批准计划前，不启动 workflow、不推进节点、不执行修改。
- [ ] 高风险能力默认关闭或只读，直到权限和审计完成。
- [ ] 所有临时文件放在项目根目录 `.tmp/`。
- [ ] 所有文本写入保持 LF。
- [ ] 删除文件前必须单独征求用户同意。

## 2. Phase 0 - 兼容基线与范围文档

**目标:** 先定义复刻边界，建立测试基线，防止后续阶段“看起来像 tui-code、实际语义不一致”。

**Files:**
- Create: `docs/tui-code-replication-scope.md`
- Create: `tests/compat/replicationScope.test.ts`
- Modify: `tsconfig.test.json` only if current test include pattern does not include `tests/compat/**/*.ts`

**Steps:**

- [x] Step 0.1: 新增范围文档，列出每个 `tui-code` 模块的处理策略：replicate、adapt、defer、exclude。
- [x] Step 0.2: 写 `replicationScope.test.ts`，断言范围文档存在，并包含 `QueryEngine`、`Tool`、`PermissionMode`、`Plan Mode`、`Session Storage`、`MCP`、`Tasks`、`SDK/headless`、`TUI logging excluded`、`Remote excluded`。
- [x] Step 0.3: 范围文档必须明确：不实现远程能力，不创建远程传输、不做远程恢复、不引入真实网络控制面。
- [x] Step 0.4: 运行 `npm run build:test`，确认测试编译失败或通过；如果失败原因是测试未被纳入，调整 `tsconfig.test.json`。
- [x] Step 0.5: 运行 `npm test`，确认 baseline。

**Acceptance:**
- 范围文档存在，且明确排除 TUI 日志系统、外发 telemetry 和远程能力实现。
- 测试能防止后续删除范围约束。

## 3. Phase 1 - Runtime Core

**目标:** 引入 conversation-first runtime，使普通会话、Plan Mode 会话和 workflow 节点共用同一个 turn executor。

**Files:**
- Create: `src/runtime/types.ts`
- Create: `src/runtime/turnExecutor.ts`
- Create: `src/runtime/session.ts`
- Modify: `src/harness/runtime.ts`
- Modify: `src/workflow/engine.ts`
- Test: `tests/runtime/turnExecutor.test.ts`
- Test: `tests/workflow/engine.test.ts`

**Design:**

`RuntimeTurnExecutor` 是新的最小核心。它不理解 workflow graph，也不依赖 React/TUI。输入是 messages、provider、tools、permission context、event sink；输出是 assistant response、tool results、final node result 或需要继续的状态。

```ts
export type RuntimeTurnInput = {
  messages: ModelMessage[];
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: ToolPermissionContext;
  cwd: string;
  sessionId: string;
  runId?: string;
  eventSink?: (event: RuntimeEvent) => void | Promise<void>;
};

export type RuntimeTurnResult =
  | { status: "completed"; messages: ModelMessage[]; result?: unknown }
  | { status: "waiting_permission"; messages: ModelMessage[] }
  | { status: "waiting_plan_approval"; messages: ModelMessage[]; plan: PlanApprovalRequest }
  | { status: "failed"; error: string; messages: ModelMessage[] };
```

**Steps:**

- [x] Step 1.1: 写测试：给一个无工具 provider，`turnExecutor` 返回 completed，并保留 assistant message。
- [x] Step 1.2: 实现 `RuntimeTurnInput`、`RuntimeTurnResult`、`RuntimeEvent` 类型，事件必须支持 session-level plan 事件。
- [x] Step 1.3: 从 `src/harness/runtime.ts` 抽取 provider 调用和 assistant message 追加逻辑。
- [x] Step 1.4: 写测试：带工具调用时，executor 调用工具并把 tool result 加回 messages。
- [x] Step 1.5: 让 `runNode` 调用 `RuntimeTurnExecutor`，但保留原有 `NodeResult` JSON 协议。
- [x] Step 1.6: 写测试：Plan Mode turn 可以运行 runtime，但不会调用 workflow engine。
- [x] Step 1.7: 运行 `npm test -- tests/runtime/turnExecutor.test.ts tests/workflow/engine.test.ts`；如果脚本不支持路径参数，运行 `npm test`。

**Acceptance:**
- workflow 行为不变。
- 新 runtime 可以脱离 workflow 单独测试。
- Plan Mode 可以复用 runtime 对话能力，但不会启动流程。

## 4. Phase 2 - Tool Interface and Orchestration

**目标:** 对齐 `tui-code` 的工具元数据和调度能力，为权限、Plan Mode、MCP、插件打基础。

**Files:**
- Modify: `src/tools/types.ts`
- Create: `src/tools/orchestration.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/tools/local/*.ts`
- Test: `tests/tools/orchestration.test.ts`

**Design:**

扩展工具接口，但所有新增字段先做可选，避免一次性修改所有工具。

```ts
export type ToolSafety = {
  isReadOnly?: () => boolean;
  isConcurrencySafe?: () => boolean;
  isDestructive?: (input: unknown) => boolean | Promise<boolean>;
  writesPlanFile?: (input: unknown, context: ToolContext) => boolean | Promise<boolean>;
  requiresUserInteraction?: (input: unknown) => boolean | Promise<boolean>;
};

export type Tool<Input = unknown, Output = unknown> = ToolSafety & {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute(input: Input, context: ToolContext): Promise<Output>;
  validateInput?: (input: unknown, context: ToolContext) => Promise<{ result: true } | { result: false; message: string }>;
  mapToolResultToModelResult?: (output: Output) => unknown;
};
```

**Steps:**

- [x] Step 2.1: 写测试：连续三个 read-only 工具并发执行，总耗时小于串行阈值。
- [x] Step 2.2: 写测试：包含 write 工具时按原顺序串行。
- [x] Step 2.3: 实现 `executeToolCalls`，按连续 concurrency-safe 分组并发，其他串行。
- [x] Step 2.4: 标记 `Read`、`LS`、`Glob`、`Grep` 为 read-only + concurrency-safe。
- [x] Step 2.5: 标记 `Write`、`Edit`、`MultiEdit`、`Bash`、`PowerShell` 为非并发；shell 工具必须能被 destructive classifier 判断。
- [x] Step 2.6: 标记计划文件写入能力，只有 `.session/plans/` 下的计划草稿可在 Plan Mode 写入。
- [x] Step 2.7: 接入 runtime executor。

**Acceptance:**
- 读工具可以并发。
- 写和 shell 工具顺序不变。
- Plan Mode 下只有读工具和计划草稿写入可通过权限检查。
- 原工具 API 调用方不破坏。

## 5. Phase 3 - Permission Mode System

**目标:** 把当前 allow/ask/deny 规则升级为 session-level permission mode，并让 `permission_mode: "plan"` 真正具备安全语义。

**Files:**
- Create: `src/permissions/PermissionMode.ts`
- Create: `src/permissions/context.ts`
- Create: `src/permissions/checkToolPermission.ts`
- Modify: `src/harness/permissions.ts`
- Modify: `src/harness/permissionController.ts`
- Modify: `src/harness/runtime.ts`
- Test: `tests/permissions/permissionMode.test.ts`

**Design:**

```ts
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

export type ToolPermissionContext = {
  mode: PermissionMode;
  prePlanMode?: PermissionMode;
  allow: string[];
  ask: string[];
  deny: string[];
  source?: "workflow" | "session" | "settings";
  planFilePath?: string;
};
```

**Steps:**

- [x] Step 3.1: 写测试：`default` 模式沿用 allow/ask/deny。
- [x] Step 3.2: 写测试：`bypassPermissions` 允许非 destructive 工具，但 destructive 仍可被 deny 规则挡住。
- [x] Step 3.3: 写测试：`plan` 模式允许 read-only 工具，拒绝普通写工具。
- [x] Step 3.4: 写测试：`plan` 模式允许写入当前 session 的 plan 文件，拒绝写入其他路径。
- [x] Step 3.5: 写测试：`plan` 模式拒绝 Bash/PowerShell 中的文件修改、删除、git destructive 操作和任意 workflow 执行动作。
- [x] Step 3.6: 实现 `checkToolPermission(tool, input, context)`。
- [x] Step 3.7: 将 runtime 工具调用权限入口替换为 `checkToolPermission`。
- [x] Step 3.8: 保留 `PermissionController` 的交互审批，但审批结果只影响当前 request。

**Acceptance:**
- `permission_mode: "plan"` 是安全模式，不只是 UI 状态。
- 现有 workflow 权限规则继续生效。
- Plan Mode 下不会出现“模型调用工具后顺手改文件”的路径。

## 6. Phase 4 - Plan Mode V2

**目标:** 复刻 `tui-code` 的全局 Plan Mode，并支持用户在 workflow 流程执行前先规划、审批、再执行。该模式必须与当前 workflow plan 节点分层，不能复用 `node.mode === "plan"` 作为安全模式。

**Files:**
- Create: `src/plans/planFiles.ts`
- Create: `src/plans/planSession.ts`
- Create: `src/tools/local/enterPlanMode.ts`
- Create: `src/tools/local/exitPlanMode.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/workflow/session.ts`
- Modify: `src/workflow/interactiveSessionRunner.ts`
- Modify: `src/tui/TuiApp.tsx`
- Test: `tests/plans/planMode.test.ts`
- Test: `tests/workflow/engine.test.ts`
- Test: `tests/tui/components.test.tsx`

**Design:**

- Plan 文件默认目录：`.session/plans/`。
- 用户可以在流程执行前通过 `/plan` 或 TUI 启动选项进入 Plan Mode。
- `EnterPlanMode` 将 session 的 `ToolPermissionContext.mode` 设为 `plan`，并保存 `prePlanMode`。
- Plan Mode 下只运行规划对话 turn，不调用 `WorkflowEngine.run`、不执行 `continueFrom`、不推进任何 workflow node。
- 规划结果写入 session plan 文件；计划文件是唯一允许写入的目标。
- `ExitPlanMode` 读取 plan 文件，生成 session-level plan approval request。
- 用户批准后恢复 `prePlanMode` 或指定模式，并以“原始用户请求 + 已批准计划”启动 workflow。
- 用户拒绝后保持 Plan Mode，并把反馈作为下一轮规划输入。
- 当前 `node.mode === "plan"` 继续作为 workflow 内部审核节点；它使用 `pending_review`，但不承担全局权限隔离。

**State:**

```ts
export type PlanSessionState = {
  mode: "inactive" | "planning" | "waiting_approval";
  sessionId: string;
  planFilePath: string;
  prePlanMode: PermissionMode;
  originalInput: unknown;
  approvedPlan?: string;
};
```

**Events:**

```ts
export type PlanModeEvent =
  | { type: "plan_mode_entered"; session_id: string; plan_file_path: string }
  | { type: "plan_draft_updated"; session_id: string; plan_file_path: string }
  | { type: "plan_approval_requested"; session_id: string; document: string; plan_file_path: string }
  | { type: "plan_approval_resolved"; session_id: string; decision: "continue" | "stay" };
```

**Steps:**

- [x] Step 4.1: 写测试：`getPlanFilePath(sessionId)` 返回稳定路径，且不同 session 不冲突。
- [x] Step 4.2: 实现 `planFiles.ts` 的 `getPlanSlug`、`getPlanFilePath`、`readPlan`、`writePlan`。
- [x] Step 4.3: 写测试：`EnterPlanMode` 从 default 进入 plan，并记录 `prePlanMode` 和 `originalInput`。
- [x] Step 4.4: 实现 `PlanSessionState` 和 `EnterPlanMode` 工具。
- [x] Step 4.5: 写测试：进入 Plan Mode 后不会调用 `WorkflowEngine.run`。
- [x] Step 4.6: 写测试：Plan Mode 下 `Write` 非 plan 文件被拒绝，当前 plan 文件允许。
- [x] Step 4.7: 写测试：`ExitPlanMode` 无 plan 文件或空 plan 时返回可审计错误。
- [x] Step 4.8: 实现 `ExitPlanMode` 工具和 session-level plan approval event。
- [x] Step 4.9: 写测试：批准计划后恢复 `prePlanMode`，并把批准计划注入 workflow 初始 handoff。
- [x] Step 4.10: 写测试：拒绝计划后保持 Plan Mode，用户反馈进入下一轮规划消息。
- [x] Step 4.11: 保留 workflow `node.mode === "plan"` 的 `pending_review` 行为，只共享展示组件，不共享权限状态。

**Acceptance:**
- Plan Mode 是流程前安全模式，不只是 UI 暂停。
- 未批准计划前不会执行 workflow、不会执行节点、不会修改普通文件。
- 当前 workflow plan 节点测试继续通过。

## 7. Phase 5 - Attachments and Context Pipeline

**目标:** 复刻 `tui-code` 的上下文附件机制，让模型持续收到 Plan Mode 约束、计划草稿和退出信息。

**Files:**
- Create: `src/context/attachments.ts`
- Create: `src/context/messages.ts`
- Modify: `src/harness/context.ts`
- Modify: `src/runtime/turnExecutor.ts`
- Test: `tests/context/attachments.test.ts`

**Steps:**

- [x] Step 5.1: 写测试：首次 Plan Mode turn 注入 full `plan_mode` attachment，明确“只规划、不执行、不修改普通文件”。
- [x] Step 5.2: 写测试：后续 Plan Mode turn 注入 sparse reminder。
- [x] Step 5.3: 写测试：退出 Plan Mode 后只注入一次 `plan_mode_exit`。
- [x] Step 5.4: 写测试：批准计划启动 workflow 时，初始 handoff 包含 approved plan 和 original input。
- [x] Step 5.5: 实现 attachment 类型和生成逻辑。
- [x] Step 5.6: 将 `buildNodeMessages` 改为调用 `buildRuntimeMessages`。
- [x] Step 5.7: 覆盖 workflow handoff、images、pending review、Plan Mode approval 四类上下文。

**Acceptance:**
- 模型在 Plan Mode 中始终收到只读和不执行流程约束。
- 退出 Plan Mode 后明确允许按已批准计划执行。

## 8. Phase 6 - Session Storage and Resume

**目标:** 从 run state 扩展为 transcript + metadata + index，支持完整恢复，并能恢复 Plan Mode 草稿与审批状态。

**Files:**
- Create: `src/storage/sessionStore.ts`
- Create: `src/storage/sessionIndex.ts`
- Modify: `src/storage/runStore.ts`
- Modify: `src/workflow/engine.ts`
- Test: `tests/storage/sessionStore.test.ts`

**Storage Layout:**

```text
.session/
  index.json
  runs/{run_id}/state.json
  runs/{run_id}/events.ndjson
  sessions/{session_id}/transcript.jsonl
  sessions/{session_id}/metadata.json
  plans/{slug}.md
```

**Steps:**

- [x] Step 6.1: 写测试：保存 transcript 后可按 session id 读取。
- [x] Step 6.2: 写测试：index 缺失时可从 metadata 重建。
- [x] Step 6.3: 写测试：Plan Mode 草稿、`prePlanMode`、`originalInput` 可恢复。
- [x] Step 6.4: 实现 `SessionStore`。
- [x] Step 6.5: 实现 `SessionIndex`。
- [x] Step 6.6: 将 `RunStore.listRuns` 迁移到 index 优先，旧结构 fallback。
- [x] Step 6.7: 添加 plan 文件恢复测试。

**Acceptance:**
- 旧 `.session/{run_id}` 数据可恢复。
- 新 session 不需要扫描所有 events 就能列出。
- Plan Mode 中断后恢复仍不会自动执行 workflow。

## 9. Phase 7 - Commands and Input Processing

**目标:** 对齐 slash command 和普通输入处理，新增流程前 `/plan` 入口。

**Files:**
- Create: `src/input/processUserInput.ts`
- Create: `src/commands/registry.ts`
- Create: `src/commands/plan.ts`
- Create: `src/commands/clear.ts`
- Create: `src/commands/resume.ts`
- Create: `src/commands/model.ts`
- Create: `src/commands/permissions.ts`
- Modify: `src/tui/commands.ts`
- Modify: `src/tui/commandCompletion.ts`
- Modify: `src/tui/TuiApp.tsx`
- Test: `tests/commands/*.test.ts`
- Test: `tests/input/processUserInput.test.ts`
- Test: `tests/tui/commandCompletion.test.ts`

**Steps:**

- [x] Step 7.1: 写测试：普通文本返回 `type: "query"`。
- [x] Step 7.2: 写测试：`/plan` 返回 command action，不调用模型、不调用 workflow。
- [x] Step 7.3: 实现 command registry。
- [x] Step 7.4: 实现 `/plan`：不在 Plan Mode 时进入，在 Plan Mode 时展示 plan 或触发退出审批。
- [x] Step 7.5: 实现 `/clear`：清上下文但保留 session metadata 和明确的 Plan Mode 状态。
- [x] Step 7.6: 实现 `/resume`：列出 session index，并能恢复 planning / waiting_approval / workflow run。
- [x] Step 7.7: TUI 输入统一走 `processUserInput`。

**Acceptance:**
- slash command 和模型输入严格分离。
- `/plan` 行为与 Plan Mode V2 一致。
- 用户在流程执行前可以进入 Plan Mode，且不会误触发 workflow。

## 10. Phase 8 - Model, Provider, Usage

**目标:** 增强 provider abstraction，支持模型路由、context window、usage。

**Files:**
- Create: `src/model/modelRegistry.ts`
- Create: `src/model/modelRouting.ts`
- Create: `src/model/usage.ts`
- Modify: `src/providers/types.ts`
- Modify: `src/providers/*.ts`
- Test: `tests/model/modelRouting.test.ts`
- Test: `tests/providers/*.test.ts`

**Steps:**

- [x] Step 8.1: 写测试：普通模式使用配置默认模型。
- [x] Step 8.2: 写测试：Plan Mode 可覆盖为 plan 模型。
- [x] Step 8.3: 扩展 provider response，增加 `usage`、`stopReason`、`errorKind`。
- [x] Step 8.4: 实现 model alias 和 context window 查询。
- [x] Step 8.5: 将 usage 写入 session metadata 和 audit event。

**Acceptance:**
- workflow node model 配置继续优先。
- Plan Mode model override 不污染普通模式。

## 11. Phase 9 - Settings and Config Sources

**目标:** 从单一 workflow YAML 扩展到 user/project/session settings。

**Files:**
- Create: `src/settings/types.ts`
- Create: `src/settings/loadSettings.ts`
- Create: `src/settings/resolveSettings.ts`
- Modify: `src/config/loadConfig.ts`
- Test: `tests/settings/settings.test.ts`

**Steps:**

- [x] Step 9.1: 写测试：project settings 覆盖 user settings。
- [x] Step 9.2: 写测试：session permission mode 不持久化到 settings。
- [x] Step 9.3: 写测试：`plansDirectory` 必须在项目根内。
- [x] Step 9.4: 写测试：Plan Mode 默认入口配置不能改变 workflow YAML 语义。
- [x] Step 9.5: 实现 settings schema。
- [x] Step 9.6: 接入 permission default mode、plansDirectory、model alias。

**Acceptance:**
- `agent-team.yaml` 继续只表达 workflow。
- 产品配置不塞进 workflow schema。
- Plan Mode 是 session 状态，不是 workflow 节点配置。

## 12. Phase 10 - MCP, Plugins, Skills

**目标:** 先做扩展边界，再做生态能力。

**Files:**
- Create: `src/mcp/types.ts`
- Create: `src/mcp/client.ts`
- Create: `src/mcp/toolAdapter.ts`
- Create: `src/plugins/manifest.ts`
- Create: `src/plugins/pluginLoader.ts`
- Create: `src/skills/skillLoader.ts`
- Test: `tests/mcp/*.test.ts`
- Test: `tests/plugins/*.test.ts`
- Test: `tests/skills/*.test.ts`

**Steps:**

- [x] Step 10.1: 写测试：MCP tool 可以注入 ToolRegistry。
- [x] Step 10.2: 写测试：重复 tool name 拒绝加载。
- [x] Step 10.3: 实现 MCP tool adapter。
- [x] Step 10.4: 写测试：plugin manifest 注入 command/tool/skill。
- [x] Step 10.5: 实现 plugin loader。
- [x] Step 10.6: 实现本地 skill loader，只做 prompt 注入，不做 marketplace。
- [x] Step 10.7: 写测试：MCP/plugin 工具在 Plan Mode 下不能绕过 `checkToolPermission`。

**Acceptance:**
- 外部扩展不能绕过权限系统。
- MCP 和 plugin 工具都走统一 Tool 接口。

## 13. Phase 11 - Tasks, Agents, Swarm

**目标:** 复刻任务系统和本地 agent 编排，不实现远程 agent。

**Files:**
- Create: `src/tasks/types.ts`
- Create: `src/tasks/taskRegistry.ts`
- Create: `src/tasks/localAgentTask.ts`
- Create: `src/tasks/taskOutput.ts`
- Create: `src/tasks/planApprovalMailbox.ts`
- Test: `tests/tasks/*.test.ts`

**Steps:**

- [x] Step 11.1: 写测试：创建 background task 后可查询状态。
- [x] Step 11.2: 写测试：local agent task 使用独立 runtime session。
- [x] Step 11.3: 实现 task registry。
- [x] Step 11.4: 实现 local agent task。
- [x] Step 11.5: 写测试：teammate 提交 plan approval request。
- [x] Step 11.6: 实现本地 mailbox approve/reject。
- [x] Step 11.7: 写测试：Plan Mode 未批准前不能启动 background task 执行流程。

**Acceptance:**
- 子任务不共享主会话可变状态。
- plan approval 必须等待 approve 才能执行。
- 任务系统只做本地编排，不包含远程 agent。

## 14. Phase 12 - Local SDK and Headless API

**目标:** 提供本地 headless 调用边界，复用 runtime、permission 和 Plan Mode；不实现外部控制面、远程传输或网络恢复。

**Files:**
- Create: `src/sdk/schemas.ts`
- Create: `src/sdk/headless.ts`
- Create: `src/sdk/localSession.ts`
- Test: `tests/sdk/*.test.ts`

**Steps:**

- [x] Step 12.1: 写测试：headless query 返回结构化 events。
- [x] Step 12.2: 写测试：headless Plan Mode 未批准前不启动 workflow。
- [x] Step 12.3: 实现 SDK schema。
- [x] Step 12.4: 实现 local headless session。
- [x] Step 12.5: 写测试：SDK permission callback 能 approve/deny。
- [x] Step 12.6: 写测试：SDK plan approval callback 能 continue/stay。

**Acceptance:**
- SDK/headless 只提供本地进程内调用入口。
- SDK/headless 复用 runtime、permission 和 Plan Mode。
- 不创建 `src/remote/*`、`tests/remote/*`，不实现远程传输。

## 15. Phase 13 - Security and Audit

**目标:** 为高风险行业场景补足本地安全和审计边界。

**Files:**
- Create: `src/security/pathBoundary.ts`
- Create: `src/security/shellSafety.ts`
- Create: `src/security/gitSafety.ts`
- Create: `src/audit/auditEvent.ts`
- Create: `src/audit/auditStore.ts`
- Modify: `src/tools/local/bash.ts`
- Modify: `src/tools/local/powershell.ts`
- Modify: `src/tools/local/write.ts`
- Modify: `src/tools/local/edit.ts`
- Test: `tests/security/*.test.ts`
- Test: `tests/audit/*.test.ts`

**Steps:**

- [x] Step 13.1: 写测试：越界路径写入被拒绝。
- [x] Step 13.2: 写测试：删除命令被识别为 destructive，并进入 deny/ask。
- [x] Step 13.3: 写测试：`git reset --hard` 被拒绝，除非用户显式批准。
- [x] Step 13.4: 写测试：Plan Mode 下所有普通项目文件写入、shell 写操作和 workflow 执行入口都被审计并拒绝。
- [x] Step 13.5: 实现 path boundary。
- [x] Step 13.6: 实现 shell destructive classifier。
- [x] Step 13.7: 实现 git safety classifier。
- [x] Step 13.8: 写测试：权限决策、工具调用、shell 命令、文件写入、Plan Mode 进入/退出/审批都生成 audit event。
- [x] Step 13.9: 实现 local audit store，默认写 `.session/audit.ndjson`。

**Acceptance:**
- 安全策略集中，不散落在各工具里。
- 本地审计能回答：谁在何时因什么权限执行了什么工具。
- Plan Mode 的“不执行、不修改”边界有审计证据。

## 16. 最终回归矩阵

每个 phase 完成后运行：

```bash
npm run build
npm test
npm run lint
```

最终完成时至少覆盖以下场景：

- [x] 普通 workflow run 完成。
- [x] workflow plan 节点暂停、批准、继续。
- [x] workflow plan 节点拒绝、输入反馈、重新生成计划。
- [x] 流程执行前 `/plan` 进入 Plan Mode。
- [x] Plan Mode 下不会调用 `WorkflowEngine.run`。
- [x] Plan Mode 下读工具可用。
- [x] Plan Mode 下当前 plan 文件可写。
- [x] Plan Mode 下写非 plan 文件被拒绝。
- [x] Plan Mode 下 shell 写操作和 destructive 命令被拒绝。
- [x] `ExitPlanMode` 触发计划审批。
- [x] 用户批准计划后恢复执行权限，并按批准计划启动 workflow。
- [x] 用户拒绝计划后保持 Plan Mode，并把反馈纳入下一轮规划。
- [x] session 可恢复 plan 文件、Plan Mode 状态和 transcript。
- [x] MCP/plugin 工具不能绕过权限。
- [x] background task 不污染主 session。
- [x] SDK/headless 输出结构化事件。
- [x] SDK/headless 不包含远程传输。
- [x] destructive shell 命令被审计或拦截。

## 17. 明确不做

- 不复刻 TUI 日志系统。
- 不默认启用外发 telemetry。
- 不实现远程能力。
- 不创建远程 transport、远程 resume、远程 agent 或外部控制面。
- 不把所有配置塞进 `agent-team.yaml`。
- 不绕过当前 workflow harness 直接替换为 `tui-code` 内核。
- 不把 workflow 内部 `node.mode === "plan"` 当成全局 Plan Mode。

## 18. 建议提交拆分

提交前必须询问用户任务编号，commit message 使用 `task-{任务编号}:{任务简体中文描述}`。

推荐提交粒度：

1. 复刻范围文档和兼容测试基线。
2. runtime core。
3. tool interface and orchestration。
4. permission mode。
5. plan mode v2。
6. attachments and context pipeline。
7. session storage。
8. commands and input processing。
9. model/provider usage。
10. settings。
11. MCP/plugins/skills。
12. tasks/agents/swarm。
13. local SDK/headless。
14. security/audit。

## 19. 风险提示

这个复刻工程不应该用“大爆炸式迁移”。`tui-code` 的复杂度来自产品级会话、权限、插件生态和任务编排；如果直接搬目录，最容易出现的不是编译错误，而是安全边界失真。尤其在医疗和数据设施生产环境中，必须优先保证权限、审计、恢复和 destructive 操作拦截的正确性。

Plan Mode 是本计划中最高优先级的安全边界之一：它必须保证用户在流程执行前可以先规划，但在计划批准前不会修改普通文件、不会执行 shell 写操作、不会启动 workflow，也不会让子任务或扩展工具绕过该限制。

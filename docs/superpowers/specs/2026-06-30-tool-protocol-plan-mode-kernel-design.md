# 工具协议驱动 Plan Mode 内核级重构设计

日期：2026-06-30

## 1. 背景

当前项目已经具备 workflow、TUI、local tools、权限检查、Plan Mode UI 和模型 turn 执行能力，但这些能力的主控边界没有形成统一内核。Plan Mode 目前主要由 TUI 和局部工具桥接实现：TUI 保存 plan 会话引用、拼接 plan 消息、处理 approval resolver，并把批准后的内容转交 workflow。这种方式能跑通局部场景，但无法让模型通过统一工具协议自动完成“探索、写计划、退出计划、请求确认、批准后执行”的闭环。

`D:\work\code-ai\tui-code` 的基础架构更接近 conversation-first：Query 层持有消息循环、工具协议、权限请求、用户交互、计划模式状态和恢复语义。TUI 只是 AppState 的渲染者，不是 Plan Mode 的事实状态机。本项目要对齐的是这个基础架构思路，而不是复制 remote bridge、telemetry 或外部控制面。

本设计把当前项目重构为 Kernel 驱动架构：Plan Mode 成为 session/kernel 级模式；工具协议是模型行为约束和权限约束的唯一入口；Plan file 是规划事实源；当前 workflow 保留为内核上的执行后端。

## 2. 目标

1. 建立 `KernelSession`、`QueryEngine`、`ToolProtocol`、`PermissionKernel`、`PlanModeController`、`WorkflowBackend` 组成的内核层。
2. 让 Plan Mode 完全由工具协议驱动：模型通过 `EnterPlanMode` 进入规划，通过读工具探索，通过受限写工具更新 plan file，通过 `AskUserQuestion` 请求澄清，通过 `ExitPlanMode` 发起审批。
3. 让 TUI、SDK、headless、workflow task 共享同一套 session 状态、工具权限、消息循环和 pending interaction，不再各自实现 Plan Mode 分支。
4. 保留本项目 workflow 作为批准后的执行后端，但 workflow 不能绕过工具协议和权限内核。
5. 支持退出 Plan Mode 后的状态恢复、approval resume、workflow 幂等启动和审计。
6. 为后续 MCP、plugin、remote bridge、任务系统接入留下稳定边界，但本次不引入这些外部控制面。

## 3. 非目标

1. 不重写 workflow 的业务编排 DSL，不改变已有 workflow 配置语义。
2. 不允许 workflow config 配置或强制 Plan Mode；Plan Mode 仍是会话能力，不是 workflow 能力。
3. 不引入 remote bridge、telemetry、账号系统、外部 dashboard 或云端同步。
4. 不做大规模 UI 改版；TUI 重构重点是状态来源和交互协议，不是视觉重设计。
5. 不把 Plan Mode 做成纯提示词约束。提示词只能描述行为，真正约束必须落在工具可见性、权限、状态机和恢复逻辑上。

## 4. 架构总览

目标架构按层次拆分如下：

```text
TUI / SDK / Headless
        |
        v
KernelSession + AppState
        |
        v
QueryEngine
        |
        +-- ToolProtocol Registry
        |
        +-- PermissionKernel
        |
        +-- PlanModeController
        |
        +-- AttachmentBuilder
        |
        +-- PendingInteractionStore
        |
        v
WorkflowBackend
        |
        v
当前项目 workflow engine
```

### 4.1 KernelSession 与 AppState

`KernelSession` 是单一会话事实源，负责保存：

- `messages`：模型、用户、工具、系统事件的统一 transcript。
- `toolPermissionContext`：当前权限模式，包括 normal、plan、workflow、readOnly 等上下文。
- `planState`：Plan Mode 是否激活、plan file 路径、进入前状态、approval 状态、批准元数据。
- `workflowBinding`：当前 workflow run 的 id、状态、approved plan 绑定信息。
- `pendingInteraction`：等待用户处理的统一交互请求。
- `attachments`：按当前 session 状态生成的模型可见上下文。
- `auditContext`：操作来源、session id、turn id、approval id、恢复点。

`AppState` 是可订阅的投影，不拥有业务状态。TUI、SDK 和 headless 从 AppState 渲染或输出状态，并把用户动作转换为 Kernel intent。

### 4.2 QueryEngine

`QueryEngine` 对齐 `tui-code` 的 query 主循环，成为唯一模型 turn 执行器。它负责：

- 构造模型请求，包括 messages、attachments、visible tools、mode-specific instructions。
- 驱动 tool loop，包括 deferred tool、tool result 映射、tool call 截断和继续。
- 接收 tool permission request，并转为 `pendingInteraction.tool_permission`。
- 接收 tool user interaction request，并转为 `pendingInteraction.ask_user_question` 或 `pendingInteraction.plan_approval`。
- 在 Plan Mode、normal mode、workflow mode 之间恢复正确的 session context。
- 把模型输出、工具结果和状态迁移写回 transcript。

当前 `src/runtime/turnExecutor.ts` 的职责会拆分：模型调用和工具循环进入 `QueryEngine`；workflow 特有的步骤推进进入 `WorkflowBackend`；TUI 不再直接拼接 plan mode 消息。

### 4.3 ToolProtocol

所有工具必须注册为协议对象，而不是散落的函数调用。协议接口建议为：

```ts
export interface KernelTool<TInput, TResult> {
  name: string;
  description: string;
  modeAvailability: ToolModeAvailability;
  shouldDefer(input: TInput, context: ToolContext): boolean;
  isReadOnly(input: TInput, context: ToolContext): boolean;
  requiresUserInteraction(input: TInput, context: ToolContext): UserInteractionRequest | null;
  validateInput(input: unknown, context: ToolContext): ValidationResult<TInput>;
  checkPermissions(input: TInput, context: ToolContext): PermissionDecision;
  execute(input: TInput, context: ToolExecutionContext): Promise<TResult>;
  mapToolResultToModelResult(result: TResult, context: ToolContext): ModelToolResult;
  mutateSession?(result: TResult, context: ToolMutationContext): void;
}
```

关键点：

- 工具可见性和权限是两层。Plan Mode 下模型必须能看到 `Write` / `Edit` 等写计划所需工具，但 `PermissionKernel` 只允许写当前 plan file。
- `EnterPlanMode`、`ExitPlanMode`、`AskUserQuestion` 都是普通工具协议成员，不在 TUI 特判。
- `requiresUserInteraction` 一旦返回请求，QueryEngine 必须停止后续 tool calls，写入 pending interaction，等待用户响应。
- workflow 内部执行工具也必须经过同一 registry 和 PermissionKernel。

### 4.4 PermissionKernel

`PermissionKernel` 是唯一权限入口，替代当前分散在 local tool、runtime、TUI、workflow 的判断。它输入 tool call、session context、source 和 audit context，输出 allow、deny、askUser、defer。

Plan Mode 权限规则：

- 允许只读探索工具，例如读取文件、搜索、列目录、读取 git 信息。
- 允许 `Write` / `Edit` 只作用于当前 `planState.planFilePath`。
- 允许 `AskUserQuestion`、`ExitPlanMode`、任务清单类规划辅助工具。
- 拒绝普通代码写入、shell 写入、破坏性命令、workflow execution、background task 启动。
- 对不确定命令默认拒绝或请求用户授权，不能因为处于 TUI 就绕过。

normal mode 和 workflow mode 也走同一入口，只是策略不同。这样 SDK、headless 和未来插件不会成为旁路。

### 4.5 PlanModeController

`PlanModeController` 管理 Plan Mode 状态迁移和 plan file 事实源。核心职责：

- `enterPlanMode`：创建或恢复 plan session，设置 permission context，记录进入前模式，创建 plan file。
- `buildPlanAttachments`：生成模型可见说明，包括当前模式、计划文件路径、允许工具、退出方式。
- `requestPlanApproval`：从 plan file 读取规划内容，创建 approval request。
- `resolvePlanApproval`：处理 approve / reject，并写入 transcript。
- `buildApprovedPlanHandoff`：生成 workflow backend 可消费的 approved plan payload。
- `recoverPlanState`：从 session store 恢复 planning、waiting approval、approved pending workflow 等状态。

Plan file 是规划事实源。`ExitPlanMode` 的 `plan` 入参仅作为兼容和便利路径：如果传入 plan，则先写回 plan file；如果未传入，则读取当前 plan file。审批请求永远基于 plan file 内容构建。

### 4.6 WorkflowBackend

当前 workflow 不删除、不重写，而是收敛为 `WorkflowBackend`：

- 输入是 `ApprovedPlanHandoff`、session id、用户 intent 和 audit context。
- 负责创建或恢复 workflow run。
- 执行中需要模型 turn 时调用 QueryEngine，不直接调用旧 runtime turn executor。
- 执行中需要工具时走 ToolProtocol 和 PermissionKernel。
- 输出 workflow events，写回 KernelSession，再由 TUI/SDK/headless 渲染。

这能保留本项目既有 workflow 价值，同时避免 workflow 变成 Plan Mode 之外的第二套智能体内核。

## 5. 状态机

Kernel session 使用统一状态机：

```text
idle_input
  -> running_query
  -> planning
  -> waiting_tool_permission
  -> waiting_user_input
  -> waiting_plan_approval
  -> running_workflow
  -> interrupted_restoring
```

状态说明：

- `idle_input`：等待用户输入。
- `running_query`：QueryEngine 正在执行普通模型 turn。
- `planning`：Plan Mode 已激活，模型受 plan 权限和 plan attachments 约束。
- `waiting_tool_permission`：工具需要用户授权，后续 tool loop 暂停。
- `waiting_user_input`：模型通过工具请求澄清，等待用户回答。
- `waiting_plan_approval`：`ExitPlanMode` 已生成审批请求，等待批准或拒绝。
- `running_workflow`：approved plan 已交给 workflow backend 执行。
- `interrupted_restoring`：进程重启、中断、恢复时的过渡态。

`pendingInteraction` 使用统一 union：

```ts
type PendingInteraction =
  | ToolPermissionInteraction
  | AskUserQuestionInteraction
  | PlanApprovalInteraction
  | InterruptConfirmationInteraction;
```

UI 上不同交互可以不同展示，但内核只有这一种等待机制。任何 pending interaction 未 resolved 时，QueryEngine 不得继续消费新的模型 tool calls。

## 6. Plan Mode 数据流

### 6.1 进入计划模式

进入来源包括 `/plan`、快捷键、默认 Plan 配置、模型主动调用 `EnterPlanMode`。所有入口都调用 `PlanModeController.enterPlanMode`。

进入时：

1. 记录 `prePlanModeContext`，包括原 mode、visible tools、workflow binding。
2. 创建或恢复 plan file。
3. 设置 `toolPermissionContext.mode = plan`。
4. 生成 Plan Mode attachments，明确告诉模型：先探索、必要时问问题、只把最终方案写入 plan file、完成后调用 `ExitPlanMode`。
5. QueryEngine 继续模型 turn，TUI 只显示状态。

### 6.2 规划中

模型可以读代码、搜索、读取 docs、更新 plan file、向用户提问。权限核心要求：

- read tools 正常可用。
- write tools 可见，但只能写 plan file。
- shell 仅允许明确只读命令；任何写入、安装、启动长期进程、删除、移动都拒绝或请求用户授权。
- workflow backend 不可启动。

这修复当前项目的关键断裂点：模型在 Plan Mode 下不能只靠自然语言“说计划”，它必须有受限写 plan file 的工具能力，才能自动形成可审批事实源。

### 6.3 退出计划模式并发起审批

`ExitPlanMode` 的协议行为：

1. `validateInput` 确认当前 session 处于 Plan Mode。
2. 如输入包含 `plan`，先由受限写能力写回当前 plan file。
3. 读取 plan file，构造 `PlanApprovalRequest`。
4. `mutateSession` 设置 `pendingInteraction.plan_approval`，状态变为 `waiting_plan_approval`。
5. QueryEngine 停止后续 tool loop，等待用户 approve 或 reject。

TUI 不再调用独立的 `resolveGlobalPlan`，只渲染 approval pending，并把用户选择发送给 Kernel。

### 6.4 批准

用户 approve 后：

1. `resolvePlanApproval` 写入 approval event。
2. 恢复 `prePlanModeContext` 或进入指定目标 mode。
3. 注入 `plan_mode_exit` transcript 事件，让模型和 workflow 都能看到批准事实。
4. `buildApprovedPlanHandoff` 输出 plan file 路径、plan 内容 hash、approval id、session id、用户 intent。
5. `WorkflowBackend.startOrResume` 幂等启动 workflow。

### 6.5 拒绝

用户 reject 后：

1. approval event 写入 transcript，包含拒绝理由。
2. 保持 Plan Mode 和 plan file。
3. QueryEngine 继续 planning turn，让模型根据反馈修订 plan file。
4. 再次 `ExitPlanMode` 时生成新的 approval id。

## 7. 与 tui-code 的架构对齐点

需要对齐的不是文件名，而是责任边界：

- `tui-code` 的 Query/AppState 思路：消息循环和工具交互由查询内核控制，TUI 订阅状态。本项目应引入 `QueryEngine` 和 `KernelSession`，削弱 `TuiApp.tsx` 的业务状态机职责。
- `tui-code` 的工具协议思路：工具声明是否只读、是否 defer、是否需要用户交互、如何映射结果。本项目应把 local tools、Plan tools、workflow tools 放入统一 registry。
- `tui-code` 的权限上下文思路：权限不是工具内部随手判断，而是基于 mode 和 context 的统一决策。本项目应把 `checkToolPermission` 提升为 `PermissionKernel`。
- `tui-code` 的 Plan Mode 退出思路：退出计划不是 UI 按钮行为，而是模型 tool call 触发的 pending approval。本项目应让 `ExitPlanMode` 成为唯一审批入口。
- `tui-code` 的状态恢复思路：pending interaction 和 mode context 可恢复。本项目应把 plan approval、workflow binding 和 transcript 落入 session store。

当前项目的主要差异：

- 当前是 workflow-first / TUI-bridged；目标是 conversation-first / kernel-driven。
- 当前 Plan Mode 状态分散在 TUI refs、runtime attachments、local tools；目标是 `PlanModeController` 单点维护。
- 当前工具可见性和权限耦合，Plan Mode 下写工具不可见会导致模型无法写 plan file；目标是“可见但受限”。
- 当前 approval resolver 属于 UI 临时闭包，恢复后容易丢失；目标是持久化 pending interaction。
- 当前 workflow 能直接推进模型 turn；目标是 workflow 通过 backend 调 QueryEngine。

## 8. 模块落点

建议新增或重组模块：

```text
src/kernel/
  session.ts
  appState.ts
  queryEngine.ts
  pendingInteraction.ts
  sessionStore.ts

src/kernel/tools/
  protocol.ts
  registry.ts
  modelResult.ts

src/kernel/permissions/
  permissionKernel.ts
  policies.ts
  shellClassifier.ts

src/kernel/plan/
  planModeController.ts
  planFile.ts
  approval.ts
  attachments.ts

src/kernel/workflow/
  workflowBackend.ts
  workflowEvents.ts

src/tui/
  TuiApp.tsx
  kernelAdapter.ts
  components/PlanApproval.tsx
  components/PendingInteraction.tsx
```

迁移时不要求一次性删除旧文件。旧 `src/tools/local/enterPlanMode.ts`、`src/tools/local/exitPlanMode.ts` 可先包装成新协议工具；旧 `src/runtime/turnExecutor.ts` 可先作为 QueryEngine 的适配层，再逐步瘦身。

## 9. 接口草案

### 9.1 KernelSession

```ts
export interface KernelSession {
  id: string;
  status: KernelStatus;
  messages: KernelMessage[];
  toolPermissionContext: ToolPermissionContext;
  planState: PlanSessionState | null;
  workflowBinding: WorkflowBinding | null;
  pendingInteraction: PendingInteraction | null;
  auditContext: AuditContext;
}
```

### 9.2 PlanSessionState

```ts
export interface PlanSessionState {
  active: boolean;
  planFilePath: string;
  enteredAtTurnId: string;
  prePlanModeContext: RestorableModeContext;
  approval: PlanApprovalState | null;
  lastPlanHash: string | null;
}
```

### 9.3 ApprovedPlanHandoff

```ts
export interface ApprovedPlanHandoff {
  sessionId: string;
  approvalId: string;
  planFilePath: string;
  planText: string;
  planHash: string;
  userIntent: string;
  auditContext: AuditContext;
}
```

这些接口应保持小而稳定。不要把 TUI 组件状态、React callbacks 或 workflow 私有字段塞入 KernelSession。

## 10. 附件与模型行为约束

Plan Mode 的行为约束由三部分共同完成：

1. System / mode instruction：说明当前处于 Plan Mode，目标是形成可审批计划，不执行修改。
2. Attachments：提供 plan file 路径、当前允许工具、当前 workflow binding、用户原始意图、已知约束。
3. PermissionKernel：强制执行只读探索和 plan file 限定写入。

模型可见说明必须明确：

- 不要直接修改代码或运行 workflow。
- 如果信息不足，调用 `AskUserQuestion`。
- 把计划写入当前 plan file。
- 完成后调用 `ExitPlanMode`，不要只在普通 assistant 文本里说“计划完成”。

这也是当前项目无法自动完成规划和确认流程的根因之一：提示词、工具可见性、权限和 TUI 状态机没有闭合，模型缺少“写计划并用工具退出”的协议路径。

## 11. 恢复、幂等与审计

Session store 至少持久化：

- messages transcript。
- `toolPermissionContext`。
- `planState`，包括 plan file path、approval id、approval status、plan hash。
- `pendingInteraction`。
- `workflowBinding`。
- audit events。

恢复规则：

- 恢复到 `planning`：继续 Plan Mode，保留 plan file 和权限上下文。
- 恢复到 `waiting_plan_approval`：只展示等待审批，不启动 workflow。
- 恢复到 `approved` 但 workflow 未启动：根据 approval id 和 plan hash 幂等启动一次。
- 恢复到 `running_workflow`：绑定已有 workflow run，不重复创建。
- 任何重复 approve、重复 `ExitPlanMode`、重复 backend start 都必须通过 idempotency key 防重。

审计事件包括 enter plan、plan file write、ask question、exit plan、approve、reject、workflow start、permission deny。医疗和数据设施场景下，这些事件不是锦上添花，而是事故复盘和责任边界的基本要求。

## 12. 迁移策略

建议分四个阶段实施，降低破坏面。

### 阶段一：内核骨架和协议适配

- 新增 `KernelSession`、`PendingInteraction`、`ToolProtocol`、`PermissionKernel` 的最小实现。
- 把现有 local tools 包装到 registry。
- 保持 TUI 现状，只让部分路径通过 kernel adapter。
- 建立测试基线，确保现有 Plan Mode 测试仍可运行。

### 阶段二：Plan Mode 接管

- 新增 `PlanModeController` 和 plan file 管理。
- `EnterPlanMode` / `ExitPlanMode` 改为协议工具。
- Plan Mode 下暴露受限写工具。
- TUI 移除 plan session refs 和 resolver 闭包，改为 pending interaction 渲染。

### 阶段三：QueryEngine 接管 tool loop

- 从 `turnExecutor` 抽出 QueryEngine。
- 实现 deferred tool、requiresUserInteraction 截断、permission request 暂停和恢复。
- SDK/headless 接入同一 QueryEngine。

### 阶段四：WorkflowBackend 对齐

- workflow approved plan handoff 由 Kernel 发起。
- workflow 内部模型 turn 通过 QueryEngine。
- workflow tool call 通过 ToolProtocol 和 PermissionKernel。
- 删除或冻结旧的 TUI Plan Mode 桥接路径。

## 13. 测试矩阵

新增或调整以下测试：

- `tests/kernel/session.test.ts`：session 状态投影、pending interaction、恢复。
- `tests/kernel/queryEngine.test.ts`：tool loop、deferred tool、用户交互截断、恢复继续。
- `tests/kernel/toolProtocol.test.ts`：工具 validate、readOnly、requiresUserInteraction、result mapping。
- `tests/kernel/permissionKernel.test.ts`：normal、plan、workflow 各模式权限策略。
- `tests/kernel/planModeController.test.ts`：enter、plan file 写入、exit、approve、reject、恢复。
- `tests/workflow/kernelBackend.test.ts`：approved plan handoff、幂等 workflow start、workflow 走 QueryEngine。
- `tests/sdk/kernelSession.test.ts`：SDK/headless 与 TUI 共享 session 行为。
- `tests/tui/kernelIntegration.test.tsx`：TUI 渲染 pending interaction，不持有 Plan 主状态机。
- `tests/tui/tuiAppPlanMode.test.tsx`：保留并更新既有 Plan Mode 行为测试。

关键场景：

- Plan Mode 下模型能看到写工具，但只能写当前 plan file。
- `ExitPlanMode` 是唯一生成 plan approval 的入口。
- `requiresUserInteraction` 之后后续 tool calls 不执行。
- reject 后保持 Plan Mode 并允许继续修订。
- approve 后恢复进入前状态并启动 workflow backend。
- resume waiting approval 不重复启动 workflow。
- workflow、SDK、headless 均不能绕过 PermissionKernel。

建议验收命令：

```bash
npm run build:test
node dist-test/tests/kernel/session.test.js
node dist-test/tests/kernel/queryEngine.test.js
node dist-test/tests/kernel/toolProtocol.test.js
node dist-test/tests/kernel/permissionKernel.test.js
node dist-test/tests/kernel/planModeController.test.js
node dist-test/tests/workflow/kernelBackend.test.js
node dist-test/tests/sdk/kernelSession.test.js
node dist-test/tests/tui/kernelIntegration.test.js
node dist-test/tests/tui/tuiAppPlanMode.test.js
git diff --check
```

如果测试编译产物路径后续调整，应保持“kernel 单测、workflow backend 单测、SDK/headless 单测、TUI 集成测试”四类覆盖不缩水。

## 14. 验收标准

1. Plan Mode 是 session/kernel 级能力，不由 TUI refs 或 workflow config 主导。
2. Plan file 是规划事实源，approval 内容来自 plan file。
3. 模型可以通过工具协议自动完成规划、写计划、退出计划、请求确认。
4. TUI、SDK、headless 都通过同一 pending interaction 处理 plan approval。
5. 所有工具和 workflow 执行都经过 PermissionKernel。
6. workflow 作为 approved plan 的执行后端存在，不再是 Plan Mode 外的第二套主控内核。
7. 中断恢复后不会丢失 approval，也不会重复启动 workflow。
8. 测试矩阵覆盖核心状态机、权限策略、Plan Mode 数据流和 workflow handoff。

## 15. 风险与防线

- 风险：一次性重构过大导致回归。防线：按四阶段迁移，保留旧适配层，每阶段都有可运行测试。
- 风险：工具可见性放开后误写代码。防线：Plan Mode 下写工具只允许当前 plan file，权限以路径和 mode 双重校验。
- 风险：workflow 绕过内核。防线：WorkflowBackend 只能通过 QueryEngine 和 ToolProtocol 执行模型 turn 与工具。
- 风险：恢复时重复执行。防线：approval id、plan hash、workflow run id 组成幂等键。
- 风险：TUI 和 SDK 行为分裂。防线：两者只消费 AppState 和 Kernel intent，不持有独立业务状态。

## 16. 结论

这次重构的核心不是“修一个 Plan Mode bug”，而是把项目从 workflow-first、TUI-bridged 的局部实现升级为 conversation-first、kernel-driven 的基础架构。Plan Mode 只是最先暴露问题的场景：模型行为约束、工具权限、用户交互、审批恢复、workflow handoff 必须在同一个内核协议里闭合。

完成该方案后，本项目可以在 `tui-code` 的基础架构形态上继续使用自己的 workflow 能力，并为后续插件、MCP、headless automation 和更严格的生产审计打下完整边界。

## Implemented Module Map

- `src/kernel/session.ts`
- `src/kernel/tools/protocol.ts`
- `src/kernel/tools/registry.ts`
- `src/kernel/permissions/permissionKernel.ts`
- `src/kernel/plan/planModeController.ts`
- `src/kernel/queryEngine.ts`
- `src/kernel/workflow/workflowBackend.ts`
- `src/tui/kernelAdapter.ts`

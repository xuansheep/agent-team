# Kernel 作为唯一 Plan Mode 事实源的架构对齐设计

日期：2026-06-30

## 1. 背景

当前项目已经有 `KernelSession`、`QueryEngine`、`PermissionKernel`、`PlanModeController`、`WorkflowBackend` 等内核雏形，但 Plan Mode 仍处于 hybrid 状态。`RuntimeTurnExecutor`、TUI、SDK/headless 和 workflow 仍分别保存或推导 Plan Mode 状态，导致事实源分裂：模型对话、plan file、审批选择框、权限约束、workflow 启动和恢复并不在同一个协议闭环里。

`D:\work\code-ai\tui-code` 更接近 conversation-first 架构：query 主循环掌控消息、工具调用、权限暂停和用户交互；Plan Mode 通过工具协议、权限上下文、plan file 和 pending approval 约束模型行为；TUI 只是 AppState 的渲染者。

本设计采用方案 A：Kernel 接管 Plan Mode 主路径，旧 runtime、TUI、SDK/headless、workflow 相关 Plan Mode 分支降级为 adapter。目标是在架构上把当前 hybrid 继续推进到 Kernel 作为唯一 Plan Mode 事实源，同时满足用户可见功能场景：Plan Mode 对话、上下文记忆、任务分析与测试规划、审批选择框、确认后进入 workflow。

## 2. 目标

1. `KernelSession` 成为 Plan Mode 唯一事实源，保存 messages、permissions、plan state、pending interaction、workflow binding 和恢复元数据。
2. `QueryEngine` 成为 Plan Mode 的唯一模型主循环，负责上下文构造、Plan Mode instructions、工具可见性、tool loop、用户交互暂停和权限暂停。
3. `PlanModeController` 成为唯一 Plan Mode 状态机，负责进入、审批、批准、停留、恢复和 approved plan handoff。
4. `PermissionKernel` 成为唯一权限入口，Plan Mode 下工具可见性和可执行性分离。
5. TUI、SDK/headless 只消费 Kernel AppState，并通过 Kernel intent 提交用户动作。
6. workflow 保留当前项目编排能力，但只能作为 approved plan 的执行后端，不能拥有 Plan Mode 状态或绕过权限内核。
7. 支持中断恢复和幂等：等待审批不丢失，重复 approve 不重复启动 workflow。

## 3. 非目标

1. 不重写当前 workflow DSL 和节点编排语义。
2. 不把 Plan Mode 变成 workflow config 能力；Plan Mode 仍是 conversation/session 能力。
3. 不复制 `tui-code` 的 telemetry、remote bridge、agent swarm 或外部控制面。
4. 不在本设计阶段实现代码；设计获批后再进入 implementation plan。

## 4. 核心架构

目标结构如下：

```text
TUI / SDK / Headless
        |
        v
Kernel Intent API
        |
        v
KernelSession + KernelReducer + AppState Projection
        |
        v
QueryEngine
        |
        +-- AttachmentBuilder
        +-- KernelToolRegistry
        +-- PermissionKernel
        +-- PlanModeController
        |
        v
WorkflowBackend
        |
        v
current WorkflowEngine
```

### 4.1 KernelSession

`KernelSession` 保存 Plan Mode 的全部事实状态：

- `messages`：用户、assistant、tool、runtime attachment、approval event 的统一 transcript。
- `toolPermissionContext`：当前权限模式、进入 Plan Mode 前的模式、plan file 路径、权限规则。
- `planState`：是否 planning、是否 waiting approval、plan file 路径、original input、approval id、plan hash、反馈消息。
- `pendingInteraction`：等待用户处理的交互，包括 tool permission、ask user question、plan approval、interrupt confirmation。
- `workflowBinding`：approved plan 对应的 workflow run、状态、approval id、plan hash。
- `auditContext`：session id、turn id、approval id、run id、恢复点。

TUI 组件状态、React callback、临时 resolver 和 workflow 私有字段不得进入 `KernelSession`。

### 4.2 QueryEngine

`QueryEngine` 是 Plan Mode 模型 turn 的唯一主循环。它负责：

- 从 `KernelSession.messages` 构造模型上下文。
- 根据 `planState` 注入 Plan Mode attachment。
- 根据 `toolPermissionContext` 决定模型可见工具。
- 执行 tool loop，并在工具请求用户交互或权限时暂停。
- 把 assistant 输出、tool result、pending interaction 和状态迁移写回 `KernelSession`。
- 在恢复后从 `KernelSession` 继续，而不是依赖 TUI 内存状态。

本阶段 Plan Mode 必须走 `QueryEngine`。普通非 Plan Mode 对话可以后续逐步迁移，但不得新增新的 Plan Mode runtime 分支。

### 4.3 PlanModeController

`PlanModeController` 是唯一 Plan Mode 状态机：

- `enterPlanMode`：记录进入前权限模式，创建或恢复 plan file，设置 `toolPermissionContext.mode = "plan"`。
- `buildPlanAttachments`：生成模型可见说明，包括 plan file 路径、只读探索规则、受限写入规则、结束方式。
- `requestPlanApproval`：读取 plan file，生成 approval id、plan hash 和 `pendingInteraction.plan_approval`。
- `resolvePlanApproval`：处理执行或停留，并注入 approval event。
- `buildApprovedPlanHandoff`：生成 workflow backend 可消费的 handoff。
- `recoverPlanState`：从 session store 恢复 planning、waiting approval、approved pending workflow、running workflow。

`ExitPlanMode` 是唯一创建 plan approval 的入口。TUI 不能直接构造 approval 或启动 workflow。

### 4.4 ToolProtocol

工具必须通过 Kernel 工具协议注册。协议至少包含：

```ts
interface KernelTool<TInput, TResult> {
  name: string;
  description: string;
  inputSchema: unknown;
  visibleIn(context: ToolPermissionContext): boolean;
  validateInput(input: unknown, session: KernelSession): ValidationResult<TInput>;
  isReadOnly(input: TInput, session: KernelSession): boolean | Promise<boolean>;
  requiresUserInteraction(input: TInput, session: KernelSession): PendingInteraction | null | Promise<PendingInteraction | null>;
  execute(input: TInput, session: KernelSession): Promise<TResult>;
  mapResultToModel(result: TResult, session: KernelSession): unknown;
}
```

短期可以保留 legacy tool adapter，但 `EnterPlanMode`、`ExitPlanMode`、`AskUserQuestion` 必须成为一等 Kernel tool。工具可见性和执行权限分离：Plan Mode 下模型可以看到 `Write`、`Edit`、`MultiEdit`，但只能写当前 plan file。

### 4.5 PermissionKernel

`PermissionKernel` 是唯一权限入口。Plan Mode 策略：

- 允许读工具探索代码和文档。
- 允许 `Write`、`Edit`、`MultiEdit` 只作用于 `planState.planFilePath`。
- 允许 `TodoWrite` 作为 planning 辅助，但审批事实源仍是 plan file。
- 允许 `AskUserQuestion` 和 `ExitPlanMode`。
- 拒绝普通代码写入、shell 执行、破坏性命令、workflow execution、background task 启动。
- 不确定操作默认拒绝或转为用户权限请求，不能因来自 TUI/SDK/workflow 而绕过。

### 4.6 WorkflowBackend

`WorkflowBackend` 是 approved plan 执行后端。它输入 `ApprovedPlanHandoff`，幂等启动或恢复 workflow，并把 run id 和状态写回 `KernelSession.workflowBinding`。

幂等键为：

```text
sessionId + approvalId + planHash
```

workflow 可以继续使用当前 `WorkflowEngine`，但 workflow 不再接收或产生 Plan Mode 状态。workflow 内部后续若需要模型 turn 或工具调用，应逐步收敛到 `QueryEngine` 和 `PermissionKernel`。

## 5. 功能场景数据流

### 5.1 Plan Mode 下正确对话并获取上下文记忆

用户输入被提交为 Kernel intent，例如 `submit_user_message`。Kernel 将消息追加到 `KernelSession.messages`，`QueryEngine` 从统一 transcript 构造模型请求。Plan Mode attachment 由 Kernel 根据 `planState` 注入，TUI 不拼接 Plan Mode 提示词。

恢复会话时，Kernel 从 session store 还原 `messages`、`planState`、`pendingInteraction` 和 `workflowBinding`。如果恢复到 `planning`，继续 Plan Mode 对话；如果恢复到 `waiting_plan_approval`，只展示审批选择框，不继续模型 loop。

### 5.2 对任务进行分析、编排、测试规划

模型在 Plan Mode 内通过读工具探索代码，通过受限写工具更新 plan file。计划文件需要覆盖：

- 背景与目标。
- 现有代码依据和可复用组件。
- 推荐实施步骤。
- 影响文件。
- 测试与验证策略。
- 风险和回滚。

如果需求或取舍不明确，模型调用 `AskUserQuestion`。`QueryEngine` 设置 `pendingInteraction.ask_user_question` 并暂停。用户回答后，Kernel 把回答写入 transcript，再恢复 planning turn。

### 5.3 展开选择框让用户选择执行还是停留在 Plan Mode

模型完成 plan file 后调用 `ExitPlanMode`。`PlanModeController.requestPlanApproval` 读取 plan file，生成 `pendingInteraction.plan_approval`。

TUI 根据 pending interaction 渲染选择框，选项为：

- 执行：批准计划并启动 workflow。
- 停留在 Plan Mode：带反馈回到 planning。

TUI 不保存 resolver；用户选择会提交 `resolve_plan_approval` Kernel intent。

### 5.4 选择执行后进入 workflow 开始执行任务

用户选择执行后，`PlanModeController.resolvePlanApproval`：

1. 记录 approval event。
2. 恢复进入 Plan Mode 前的权限模式。
3. 将 plan state 标记为 inactive 或 approved。
4. 构造 `ApprovedPlanHandoff`。
5. 调用 `WorkflowBackend.startOrResume`。
6. 将 workflow run id 和状态写入 `workflowBinding`。

如果用户选择停留，则 Kernel 清除当前 approval pending，保持 `toolPermissionContext.mode = "plan"`，把反馈写入 transcript 和 plan state，随后 `QueryEngine` 继续规划。

## 6. TUI/SDK/Headless 边界

TUI 只做三件事：

1. 渲染 AppState。
2. 渲染 pending interaction。
3. 提交用户 intent。

需要迁走或冻结的 TUI 职责：

- plan session refs。
- approval resolver 闭包。
- `resolveGlobalPlan` 类直接审批逻辑。
- TUI 直接启动 workflow 的 Plan Mode 路径。
- TUI 拼接 Plan Mode prompt 的业务逻辑。

SDK/headless 使用同一 Kernel intent 和 AppState projection。它们不能维护独立 `planState` 或绕过 `PermissionKernel`。

## 7. 迁移策略

### 阶段一：Kernel 数据模型补强

- 扩展 `KernelSession`、`PendingInteraction`、`WorkflowBinding`、`KernelIntent`、`KernelEvent`。
- 增加可持久化 snapshot 和恢复 reducer。
- 增加 AppState projection。
- 测试覆盖 session 状态迁移和恢复。

### 阶段二：Plan Mode 主路径接入 QueryEngine

- Plan Mode 用户输入通过 `QueryEngine` 执行。
- Plan Mode attachment builder 从 Kernel 状态生成。
- `EnterPlanMode`、`AskUserQuestion`、`ExitPlanMode` 改成 Kernel tools。
- `ExitPlanMode` 生成 `pendingInteraction.plan_approval`。

### 阶段三：权限和 TUI 收敛

- `PermissionKernel` 实现 plan file 限定写入。
- TUI 的 Plan Review 组件改为 pending interaction 投影。
- 用户选择执行或停留只提交 Kernel intent。
- 移除或冻结 TUI 内部 plan resolver。

### 阶段四：WorkflowBackend 接管 approved plan 执行

- 用户 approve 后由 Kernel 调用 `WorkflowBackend.startOrResume`。
- workflow run id 写入 `workflowBinding`。
- 恢复时用幂等键避免重复启动。
- workflow 不接受 `permissionMode = "plan"`，也不能自己发起 Plan Mode。

## 8. 测试矩阵

核心单测：

- `tests/kernel/session.test.ts`：Kernel reducer、pending interaction、snapshot restore、workflow binding。
- `tests/kernel/queryEngine.test.ts`：Plan Mode 对话、上下文记忆、工具可见性、`AskUserQuestion` 截断、`ExitPlanMode` 截断、权限暂停。
- `tests/kernel/planModeController.test.ts`：enter、plan file 事实源、request approval、approve、stay、反馈注入、恢复、plan hash、approval id。
- `tests/kernel/permissionKernel.test.ts`：读工具允许、当前 plan file 写入允许、普通代码写入拒绝、shell 拒绝、workflow execution 拒绝。
- `tests/kernel/workflowBackend.test.ts`：approved plan handoff、幂等启动、重复 approve 不重复创建 run、workflowBinding 写回。

集成测试：

- `tests/tui/kernelIntegration.test.tsx`：TUI 渲染 `pendingInteraction.plan_approval`，用户选择只提交 Kernel intent。
- `tests/sdk/kernelSession.test.ts`：SDK/headless 与 TUI 共享 AppState 和 Plan Mode 状态。
- `tests/workflow/kernelBackend.test.ts`：workflow 从 approved handoff 启动，禁止 Plan Mode 旁路。
- `tests/tui/tuiAppPlanMode.test.tsx`：保留用户可见 Plan Mode 行为回归。

验收命令建议：

```bash
npm run build:test
node dist-test/tests/kernel/session.test.js
node dist-test/tests/kernel/queryEngine.test.js
node dist-test/tests/kernel/planModeController.test.js
node dist-test/tests/kernel/permissionKernel.test.js
node dist-test/tests/kernel/workflowBackend.test.js
node dist-test/tests/tui/kernelIntegration.test.js
node dist-test/tests/sdk/kernelSession.test.js
node dist-test/tests/workflow/kernelBackend.test.js
node dist-test/tests/tui/tuiAppPlanMode.test.js
npm test
git diff --check
```

## 9. 验收标准

1. Plan Mode 的事实源只存在于 Kernel，不存在 TUI/runtime/workflow 的第二套状态机。
2. Plan Mode 中用户可以继续对话，模型能看到历史上下文和 plan file 草稿。
3. 模型可以分析任务、读取代码、规划实施步骤和测试策略，并写入当前 plan file。
4. 模型必须通过 `ExitPlanMode` 生成 `pendingInteraction.plan_approval`，不能只用自然语言询问是否继续。
5. TUI 选择执行后由 Kernel 启动 workflow；选择停留后保持 Plan Mode 并带反馈继续规划。
6. 恢复到 `waiting_plan_approval` 时不丢选择框。
7. 恢复到 approved pending workflow 时最多启动一次 workflow。
8. 所有 Plan Mode 写入只允许当前 plan file。
9. workflow、SDK、headless 不能绕过 `PermissionKernel`。

## 10. 风险与防线

- 风险：迁移期间双事实源复活。防线：每个阶段都增加断言和测试，任何新增 Plan Mode 行为只能进入 Kernel。
- 风险：写工具可见后误写代码。防线：可见性和执行权限分离，路径必须等于 `planState.planFilePath`。
- 风险：重复点击或恢复导致 workflow 重复执行。防线：使用 `sessionId + approvalId + planHash` 幂等键。
- 风险：一次性重构破坏现有 workflow。防线：旧路径 adapter 化，先接管 Plan Mode 主路径，再逐步瘦身 runtime 和 workflow。
- 风险：SDK/headless 与 TUI 表现分裂。防线：三者只使用同一 Kernel AppState 和 intent。

## 11. 结论

本次重构不是修补 Plan Mode UI，而是把 Plan Mode 从 TUI/runtime/workflow 混合编排升级为 Kernel 驱动。与 `tui-code` 最接近的对齐点是：query 主循环掌控工具协议和用户交互，Plan Mode 通过 plan file 和 `ExitPlanMode` 形成审批事实源，TUI 只渲染 pending interaction，workflow 只在 approved handoff 后执行。

完成后，当前项目可以继续保留自己的 workflow 编排能力，同时拥有清晰的 Plan Mode 内核边界，支撑后续恢复、审计、SDK/headless 和更严格生产环境要求。

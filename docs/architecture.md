# agent-team 当前实现架构

> 文档日期：2026-08-12  
> 基线分支：dev  
> 基线提交：22ef2b62c011e3b209ee8c0011ef2d3579e8ff5a

## 1. 文档目的与事实口径

本文面向研发与架构评审，描述 agent-team 当前仓库中已经存在的运行时架构、关键调用链、编排语义、外部边界以及持久化和安全机制。

事实口径如下：

- 以 src、config、package.json、README.md 中能够相互验证的实现为准。
- dist、dist-test、node_modules 属于构建或依赖产物，不作为架构事实来源。
- 历史设计文档只用于定位代码，不把目标态或未落地能力画入架构。
- agent-team 是一个本地单进程 Node.js 应用。图中的 Kernel、Runtime、Workflow、Provider、Tool、MCP、Skill 和 Storage 都是同一进程内的逻辑组件，不是独立部署的微服务。
- 当前 CLI 始终启动交互式 TUI；原有 headless 风格命令会进入 TUI，不构成独立运行入口。
- WebFetch 是可执行的受限外联工具；WebSearch 已注册，但在没有搜索提供方时返回 unsupported 错误。

## 2. 图例

| 表达 | 含义 |
| --- | --- |
| 实线箭头 | 同步调用、控制流或主要数据流 |
| 虚线箭头 | 外部连接、流式/条件路径或动态扩展 |
| 圆柱节点 | 文件型持久化数据 |
| 浅蓝分组 | 交互或入口层 |
| 浅紫分组 | Kernel、Runtime 与编排核心 |
| 浅绿分组 | Provider、Tool、MCP、Skill 等能力层 |
| 浅黄分组 | 本地配置与持久化 |
| 浅红节点 | 被安全策略拒绝、暂停或明确不可用的路径 |

## 3. 总体分层架构

~~~mermaid
flowchart LR
    user([终端用户])
    project[/当前项目工作区/]

    subgraph entryLayer ["入口与交互层"]
        cli[CLI 入口]
        tui[TUI 应用]
        ink[React 与本地 Ink]
    end

    subgraph coreLayer ["会话与执行核心"]
        bus[SessionExecutionBus]
        coordinator[ExecutionCoordinator]
        kernel[KernelSession 与 PlanModeController]
        turn[TurnEngine]
        workflow[WorkflowEngine]
        nodeRuntime[Node Runtime]
    end

    subgraph capabilityLayer ["模型与工具能力层"]
        providers[Provider Registry]
        tools[Tool Registry]
        permissions[PermissionKernel]
        sharedPermission[共享权限规则]
        mcp[McpRuntime]
        skills[SkillRuntime]
    end

    subgraph persistenceLayer ["配置与持久化层"]
        config[(Settings 与角色编排配置)]
        sessionStore[(SessionStore)]
        runStore[(RunStore)]
        artifacts[(ArtifactStore)]
        audit[(AuditStore)]
    end

    subgraph externalLayer ["进程外部边界"]
        modelApis[模型 API]
        mcpServers[MCP Servers]
        localOs[文件系统与受管子进程]
        publicWeb[公共 HTTP 资源]
    end

    user --> cli
    cli --> tui
    tui --> ink
    tui --> bus
    project --> tui

    bus --> coordinator
    coordinator --> kernel
    coordinator --> workflow
    kernel --> turn
    workflow --> nodeRuntime
    nodeRuntime -->|"模型请求"| turn
    nodeRuntime --> sharedPermission

    turn --> providers
    turn --> permissions
    permissions --> tools
    sharedPermission --> tools
    tools --> mcp
    tools --> skills

    config --> tui
    config --> providers
    config --> workflow
    config --> mcp
    config --> skills

    coordinator --> sessionStore
    workflow --> runStore
    workflow --> artifacts
    turn --> audit
    runStore --> sessionStore
    runStore --> audit

    providers -.-> modelApis
    mcp -.-> mcpServers
    tools -.-> localOs
    tools -.-> publicWeb

    style entryLayer fill:#C2E5FF,stroke:#3DADFF
    style coreLayer fill:#DCCCFF,stroke:#874FFF
    style capabilityLayer fill:#CDF4D3,stroke:#66D575
    style persistenceLayer fill:#FFECBD,stroke:#FFC943
    style externalLayer fill:#D9D9D9,stroke:#B3B3B3
~~~

### 3.1 总体职责

- **入口与交互层**负责终端生命周期、输入编辑、命令菜单、事件展示、权限/问题/计划审批交互以及会话恢复入口。
- **会话与执行核心**负责路由用户意图、维护 Kernel 会话、执行模型 turn、启动或恢复 Workflow/Team、处理节点边界和汇总最终结果。
- **模型与工具能力层**统一模型 Provider、本地工具、MCP 工具/资源/提示词和 Skill 激活；普通会话经 PermissionKernel，节点运行时直接复用底层权限规则。
- **配置与持久化层**持久化用户设置、会话、运行事件、审计记录和不可变交付制品，并提供崩溃恢复与并发保护。
- **进程外部边界**包括模型 HTTP API、MCP 子进程或远程服务、用户项目文件系统、受管子进程和公共 HTTP 资源。

## 4. 启动与配置装配

~~~mermaid
flowchart TD
    start([执行 agent-team])
    main[cli/main]
    dispatch[dispatchCli]
    prepare[prepareTuiRuntime]

    subgraph bootstrapLayer ["启动装配"]
        projectStorage[定位 Git 项目并准备存储]
        userConfig[初始化缺失的用户配置目录]
        settings[加载并合并 Settings]
        appConfig[加载 Role Workflow Team]
        memory[合并系统提示与 AGENTS]
        history[创建项目级输入历史]
    end

    subgraph extensionLayer ["扩展发现"]
        mcpConfig[合并 MCP 配置来源]
        mcpRuntime[启动 McpRuntime]
        skillRuntime[发现 SkillRuntime]
        diagnostics[汇总运行时诊断]
    end

    subgraph engineLayer ["执行对象装配"]
        providerFactory[Provider Factory]
        workflowEngine[WorkflowEngine]
        coordinator[ExecutionCoordinator]
        render[渲染 TuiApp]
    end

    bundledConfig[(应用内置 config)]
    userSettings[(用户 settings.json)]
    userCollections[(用户 roles workflows teams)]
    userMemory[(用户 AGENTS 与 skills)]
    projectSettings[(项目 settings.json)]
    projectMemory[(项目 AGENTS 与 skills)]
    sessionFiles[(项目 Session 存储)]

    start --> main --> dispatch --> prepare
    prepare --> projectStorage
    prepare --> userConfig
    prepare --> settings
    prepare --> appConfig
    prepare --> history
    prepare --> mcpConfig
    prepare --> skillRuntime

    bundledConfig --> userConfig
    bundledConfig --> appConfig
    userSettings --> settings
    userCollections --> appConfig
    userMemory --> memory
    projectSettings --> settings
    projectMemory --> memory
    memory --> appConfig
    projectStorage --> sessionFiles

    userSettings --> mcpConfig
    projectSettings --> mcpConfig
    mcpConfig --> mcpRuntime
    mcpRuntime --> diagnostics
    skillRuntime --> diagnostics

    settings --> providerFactory
    appConfig --> providerFactory
    appConfig --> workflowEngine
    projectStorage --> workflowEngine
    mcpRuntime --> workflowEngine
    skillRuntime --> workflowEngine
    providerFactory --> workflowEngine
    workflowEngine --> coordinator
    projectStorage --> coordinator
    coordinator --> render
    settings --> render
    history --> render
    diagnostics --> render
    render --> running([交互式 TUI 运行])
    running -.-> shutdown[退出时 flush 历史并关闭 MCP]

    style bootstrapLayer fill:#C2E5FF,stroke:#3DADFF
    style extensionLayer fill:#CDF4D3,stroke:#66D575
    style engineLayer fill:#DCCCFF,stroke:#874FFF
~~~

### 4.1 配置来源与优先级

| 配置内容 | 当前来源与规则 |
| --- | --- |
| Provider、Dispatcher、权限默认值、状态栏 | 用户级 ~/.einsteins/settings.json；项目 .einsteins/settings.json 可覆盖项目相关设置 |
| Role、Workflow、Team | 运行时读取用户级 ~/.einsteins/roles、workflows、teams；目录缺失时从应用内置 config 模板原子初始化，已有目录不合并、不覆盖 |
| 强制系统提示 | 应用内置 config/prompt.md，优先级高于 AGENTS 内容 |
| AGENTS 记忆 | 用户级与从 Git 根到当前目录的项目级 .einsteins/AGENTS.md，作为补充上下文 |
| Skill | 最近项目 .einsteins/skills 优先，其次用户 ~/.einsteins/skills，最后兼容 ~/.agents/skills |
| MCP | Managed 配置存在时独占；否则同名项目 MCP 覆盖用户 MCP |
| Prompt 历史 | ~/.einsteins/history.jsonl，按 Git 项目隔离记录 |
| Session 与 Run | ~/.einsteins/projects/{projectKey}/{sessionId} |

### 4.2 启动关键约束

- Settings、Role、Workflow、Team 都经过 Zod schema 校验；缺失 Dispatcher、未知 Provider、无效节点引用或重复名称会在装配阶段失败。
- Provider 的空 api_key 不阻止 TUI 启动，直到相应 Workflow 真正创建该 Provider 时才报错。
- MCP Server 逐个启动并隔离失败，单个 Server 连接错误不会阻止整个 TUI 启动。
- TUI 退出路径负责 flush 输入历史并关闭全部 MCP 连接。
- 配置模板来自应用安装目录，运行时不会把当前项目的 config 目录当作用户 Role、Workflow、Team 来源。

## 5. 会话、Plan Mode 与工具调用链

~~~mermaid
flowchart LR
    user([用户输入])
    tui[TuiApp]
    bus[SessionExecutionBus]
    dispatcher[Bus Dispatcher]
    coordinator[ExecutionCoordinator]
    kernel[KernelSession]
    plan[PlanModeController]
    turn[TurnEngine]
    provider[ModelProvider]
    modelApi[模型 API]
    registry[KernelToolRegistry]
    permission[PermissionKernel]
    toolExec[Tool Orchestration]
    localTools[本地工具]
    mcpTools[MCP 能力]
    skillTools[Skill 能力]
    sessionStore[(SessionStore)]
    audit[(AuditStore)]

    user --> tui
    tui --> bus
    bus --> dispatcher
    dispatcher -->|"answer 或 clarify"| tui
    dispatcher -->|"dispatch 或 plan"| coordinator

    coordinator --> kernel
    kernel --> turn
    turn --> provider
    provider -.-> modelApi
    modelApi -.->|"stream 或 response"| provider
    provider --> turn

    turn --> registry
    registry --> permission

    permission -->|"allow"| toolExec
    permission -->|"ask"| pendingPermission{等待权限?}
    permission -->|"deny"| denied[记录拒绝结果]
    pendingPermission -->|"允许一次"| toolExec
    pendingPermission -->|"拒绝一次"| denied

    toolExec --> localTools
    toolExec --> mcpTools
    toolExec --> skillTools
    localTools --> turn
    mcpTools --> turn
    skillTools --> turn
    denied --> turn

    turn --> pendingUser{需要用户输入?}
    pendingUser -->|"AskUserQuestion"| tui
    tui -->|"回答"| turn

    turn --> plan
    plan -->|"ExitPlanMode"| pendingPlan{等待计划审批?}
    pendingPlan -->|"继续规划"| kernel
    pendingPlan -->|"批准执行"| coordinator
    coordinator -->|"绑定并启动"| workflowBackend[WorkflowEngine]

    turn --> audit
    coordinator --> sessionStore
    kernel --> sessionStore
    bus --> sessionStore
    sessionStore -.->|"恢复 Kernel 与 Bus 检查点"| bus

    style pendingPermission fill:#FFECBD,stroke:#FFC943
    style pendingUser fill:#FFECBD,stroke:#FFC943
    style pendingPlan fill:#FFECBD,stroke:#FFC943
    style denied fill:#FFCDC2,stroke:#FF7556
~~~

### 5.1 主循环语义

1. TUI 将普通用户输入交给 SessionExecutionBus。
2. Bus Dispatcher 结合当前阶段、会话消息和完整 Workflow dossier，返回可验证的 answer、clarify、plan、dispatch 或 finalize 指令。
3. 需要模型会话时，ExecutionCoordinator 将 KernelSession 中的 messages、权限模式、Plan 状态和 Workflow 绑定投影给 TurnEngine。
4. TurnEngine 通过 Provider 发起普通或流式模型请求，处理重试、上下文压缩、模型消息和工具调用。
5. 工具调用先适配为 KernelTool，再经 PermissionKernel 决策。只有 allow 路径能够进入 Tool Orchestration。
6. 工具结果回填模型消息循环；需要权限、用户回答或 Plan 审批时，循环在 pending interaction 边界暂停。
7. Plan 获批后，ExecutionCoordinator 将批准事实与 handoff 绑定到 WorkflowSession，并启动或恢复指定节点。
8. Kernel、Bus、Transcript 和审计事件持续写入 SessionStore，支持重新进入 TUI 后恢复。

### 5.2 Plan Mode 强制边界

- Plan Mode 是 KernelSession 的会话状态，不是 Workflow 节点配置。
- Read-only 工具可执行；AskUserQuestion 可执行；ExitPlanMode 转换为审批交互。
- Write、Edit、MultiEdit 只能精确写入当前 plan file。
- Bash、PowerShell 和 Workflow/Agent 执行工具被拒绝。
- 显式 deny 规则优先于 Plan Mode、fullAccess 和节点 allow 规则。
- 计划审批可选择继续规划，或批准并切换到非 plan 权限模式执行。

### 5.3 Provider 与工具边界

| 能力 | 当前实现 |
| --- | --- |
| Provider | Responses API、Anthropic Messages；统一支持请求/流重试、超时与 usage |
| 本地文件工具 | Read、Write、Edit、MultiEdit、LS、Glob、Grep，受权限和路径边界控制 |
| Shell | Bash、Windows 上的 PowerShell；后台任务必须通过受管 ProcessStart/Status/Stop |
| 交互工具 | EnterPlanMode、ExitPlanMode、AskUserQuestion、TodoWrite、AttachImage |
| 制品工具 | ArtifactWrite、ArtifactRead，接入不可变 revision 存储 |
| WebFetch | 仅 http/https，DNS 解析后拒绝私有/回环/链路本地等地址，30 秒超时，响应上限 5 MB |
| WebSearch | 已注册占位工具；未配置搜索 Provider 时明确返回 unsupported |
| MCP | 延迟 ToolSearch、动态 MCP tool、resource 和 prompt 能力 |
| Skill | ListSkills、UseSkill、路径触发激活以及受约束的 fork 执行 |

## 6. Workflow 与 Team 编排

~~~mermaid
flowchart TD
    input([用户任务或已批准 Plan])
    bus[SessionExecutionBus]
    choose{执行种类}

    subgraph workflowMode ["Workflow 固定顺序模式"]
        wfStart[选择起始节点]
        wfNode[执行当前节点]
        wfResult{NodeResult direction}
        wfForward[前进或恢复下游节点]
        wfBackward[挂起当前节点并恢复上游]
        wfRetry[同节点新 activation 重试]
        wfUser[首节点退回用户]
        wfLimit{达到返工上限}
        wfBoundary[末节点边界]
    end

    subgraph teamMode ["Team 动态路由模式"]
        teamDossier[构建完整 Run Dossier]
        teamDispatch[Dispatcher 选择任意成员]
        teamNode[执行选中成员]
        teamBoundary[节点成功或失败边界]
        teamDecision{重新派发或结束}
        teamFinalize[生成最终 TaskSummary]
    end

    runStore[(RunStore)]
    artifacts[(ArtifactStore)]
    eventStream[持久化 Event Stream]
    output([TUI 展示或等待用户])

    input --> bus --> choose
    choose -->|"workflow"| wfStart
    wfStart --> wfNode --> wfResult
    wfResult -->|"forward"| wfForward
    wfForward --> wfBoundary
    wfResult -->|"backward"| wfBackward
    wfBackward --> wfLimit
    wfResult -->|"retry"| wfRetry
    wfRetry --> wfLimit
    wfLimit -->|"未超限"| wfNode
    wfLimit -->|"已超限"| wfUser
    wfResult -->|"首节点 backward"| wfUser
    wfUser --> output
    output -.->|"用户继续"| wfNode
    wfBoundary --> bus

    choose -->|"team"| teamDossier
    teamDossier --> teamDispatch --> teamNode --> teamBoundary
    teamBoundary --> bus
    bus --> teamDecision
    teamDecision -->|"dispatch"| teamDossier
    teamDecision -->|"finalize"| teamFinalize
    teamFinalize --> artifacts
    teamFinalize --> output

    wfNode --> runStore
    teamNode --> runStore
    runStore --> eventStream
    eventStream -.-> bus
    artifacts --> eventStream

    style workflowMode fill:#C2E5FF,stroke:#3DADFF
    style teamMode fill:#DCCCFF,stroke:#874FFF
    style wfLimit fill:#FFECBD,stroke:#FFC943
    style wfUser fill:#FFECBD,stroke:#FFC943
~~~

### 6.1 两种编排语义

| 维度 | Workflow | Team |
| --- | --- | --- |
| 节点集合 | nodes 是有序执行链 | nodes 是可动态选择的成员池 |
| 路由依据 | 当前节点位置、direction、suspended stack | 每个节点边界的完整 dossier 与 Dispatcher 模型决策 |
| 节点完成后 | forward 到下一节点，或 backward/retry | 必须回到 Bus，重新选择成员或 finalize |
| 退回语义 | backward 挂起当前节点，恢复上游同 attempt 的新 activation | 通过 Bus reassignment 指派成员，不使用固定上游/下游 |
| 用户交互 | 首节点可 backward 到用户；节点可 AskUserQuestion | Bus 可 clarify；成员也可暂停等待用户 |
| 完成语义 | 末节点 forward 后进入 Bus 边界 | Dispatcher 用 FinalizeTask 输出结构化 TaskSummary |
| 返工控制 | rework_count 与 rework_limit，默认上限 99 | 共用运行状态计数，并由 Bus 控制后续派发 |

### 6.2 节点执行边界

- 每个节点从 Role 构建系统提示，注入当前、前序、后序位置描述以及 handoff。
- Node Runtime 复用 Provider 抽象、ToolRegistry 和 TurnEngine.requestModel，但保留 Workflow 专用工具循环，并直接调用共享的 checkToolPermission；它没有经过普通会话的 PermissionKernel 适配层。
- NodeResult 必须通过 schema 校验，明确 direction、summary、feedback、handoff 和 deliverables。
- 每次重新激活增加 activation；普通 backward 不创建新的 attempt，从对话检查点继续。
- 节点完成、失败或中断时，ManagedProcessManager 回收该节点启动的受管进程。
- 节点输出没有用户交付文件时，运行时生成 Markdown 说明 artifact；最终汇总也写为不可变 artifact。

## 7. 持久化、恢复与安全架构

~~~mermaid
flowchart LR
    runtime[Kernel Runtime Workflow]
    settingsUpdater[Settings 更新器]
    sessionStore[SessionStore]
    runStore[RunStore]
    artifactStore[ArtifactStore]
    auditStore[AuditStore]

    subgraph userState ["用户级状态"]
        settingsFile[(settings.json)]
        historyFile[(history.jsonl)]
        collections[(roles workflows teams skills)]
    end

    subgraph projectState ["项目级配置"]
        projectSettings[(.einsteins settings.json)]
        agentsFiles[(AGENTS 与 skills)]
    end

    subgraph sessionState ["Session 目录"]
        sessionJson[(session.json 与 backup)]
        transcript[(transcript.jsonl)]
        busRouting[(bus-routing.jsonl)]
        auditLog[(audit.ndjson)]
        planFile[(plans plan.md)]
    end

    subgraph runState ["Run 目录"]
        runJson[(run.json)]
        stateJson[(state.json 与 backup)]
        events[(events.ndjson)]
        dialogue[(dialogue journals)]
        artifacts[(artifacts revisions 与 index)]
        runLease[(run.lease)]
    end

    subgraph protectionLayer ["一致性与安全机制"]
        pathBoundary[路径与存储 ID 校验]
        permissionRules[allow ask deny 与 Plan 限制]
        fileLease[文件租约与写入队列]
        atomicWrite[原子写与主备恢复]
        fingerprint[配置指纹与恢复校验]
        toolLedger[工具事件账本]
        hashIndex[SHA-256 与不可变 revision]
        shellSafety[破坏命令与后台进程策略]
        ssrf[WebFetch SSRF 防护]
    end

    runtime --> sessionStore
    runtime --> runStore
    runtime --> artifactStore
    runtime --> auditStore
    settingsUpdater --> settingsFile
    settingsUpdater --> projectSettings

    sessionStore --> sessionJson
    sessionStore --> transcript
    sessionStore --> busRouting
    sessionStore --> planFile
    auditStore --> auditLog

    runStore --> runJson
    runStore --> stateJson
    runStore --> events
    runStore --> dialogue
    runStore --> runLease
    artifactStore --> artifacts

    settingsFile --> runtime
    historyFile --> runtime
    collections --> runtime
    projectSettings --> runtime
    agentsFiles --> runtime

    pathBoundary --> sessionStore
    pathBoundary --> artifactStore
    permissionRules --> runtime
    fileLease --> settingsUpdater
    fileLease --> sessionStore
    fileLease --> runStore
    fileLease --> artifactStore
    atomicWrite --> settingsFile
    atomicWrite --> sessionJson
    atomicWrite --> stateJson
    fingerprint --> runStore
    toolLedger --> events
    hashIndex --> artifacts
    shellSafety --> runtime
    ssrf --> runtime

    style userState fill:#C2E5FF,stroke:#3DADFF
    style projectState fill:#DCCCFF,stroke:#874FFF
    style sessionState fill:#FFECBD,stroke:#FFC943
    style runState fill:#CDF4D3,stroke:#66D575
    style protectionLayer fill:#FFCDC2,stroke:#FF7556
~~~

### 7.1 物理存储布局

~~~text
~/.einsteins/
  settings.json
  history.jsonl
  roles/
  workflows/
  teams/
  AGENTS.md
  skills/
  projects/
    {projectKey}/
      project.json
      {sessionId}/
        session.json
        session.backup.json
        transcript.jsonl
        bus-routing.jsonl
        audit.ndjson
        plans/
          plan.md
        runs/
          {runId}/
            run.json
            state.json
            state.backup.json
            events.ndjson
            dialogue/
            artifacts/
              index.json
              index.backup.json
              {nodeId}/
                r0001-{logicalName}
~~~

实际 backup 文件名由 atomic JSON helper 和目标文件扩展名规则生成；上图以语义名称表示主副本关系。

### 7.2 恢复与一致性保证

- **项目隔离**：优先以 Git 根作为 projectPath，生成受长度限制的 projectKey，并用 project.json 检测路径键碰撞。
- **会话恢复**：session.json 保存 Kernel checkpoint、Plan 状态、Bus checkpoint、Run 绑定和 usage；transcript 保存用户、Bus 与 Workflow 对话。
- **运行恢复**：state.json 保存 WorkflowState V5，包括 current node、attempt/activation、suspended stack、node checkpoints、返工计数和 pending interaction。
- **崩溃容错**：关键 JSON 使用同目录临时文件、flush/fsync、原子替换和 backup 回退；JSONL 读取会忽略崩溃导致的末尾 torn line。
- **并发控制**：Run 使用跨进程 run.lease；Session transcript、settings、artifact index 和 audit 写入使用文件租约或串行写队列。
- **安全恢复**：Workflow 配置和 Role 内容参与 SHA-256 指纹；配置漂移时拒绝不安全恢复。
- **未知工具结果**：events.ndjson 记录工具开始、完成和失败，恢复时避免自动重放结果未知的非只读调用。
- **不可变制品**：同一 logical_name 每次写入分配新的 revision，index 记录 SHA-256；旧 revision 不被覆盖。
- **审计**：工具调用、权限决策、Plan 事件、模型重试、artifact 读写等写入 Session 级 audit.ndjson。

## 8. 核心组件职责与源码追溯

| 组件 | 核心职责 | 状态或输出 | 主要源码 |
| --- | --- | --- | --- |
| CLI | 固定进入交互式 TUI | 进程退出码 | src/cli/main.ts、src/cli/dispatch.ts |
| TUI Bootstrap | 装配 Settings、Config、Storage、MCP、Skill 和执行引擎 | PreparedTuiRuntime | src/tui/launchTui.tsx |
| TuiApp | 渲染会话、日志、工作流图和交互区；转发用户 intent | UI reducer state | src/tui/TuiApp.tsx |
| SessionExecutionBus | 用户、Plan、生命周期三阶段路由；协调 Workflow 边界 | BusTaskState、BusEvent | src/runtime/sessionExecutionBus.ts |
| Bus Dispatcher | 用独立模型请求选择 answer、clarify、plan、dispatch、finalize | DispatchDirective | src/runtime/busDispatcher.ts |
| ExecutionCoordinator | 统一 Plan turn、审批解析、Workflow 启动/恢复与绑定 | KernelSession、WorkflowSession | src/runtime/executionCoordinator.ts |
| KernelSession | 会话消息、权限模式、Plan 状态、Workflow 绑定、pending interaction 的事实源 | Kernel checkpoint | src/kernel/session.ts |
| PlanModeController | 采纳审批、解析继续/停留选择、生成执行 handoff | PlanApprovalResolutionResult | src/kernel/plan/planModeController.ts |
| TurnEngine | 模型 request/stream、tool loop、用户输入队列、重试与审计 | RuntimeTurnResult | src/runtime/turnEngine.ts |
| PermissionKernel | 在统一规则前增加 Plan Mode 强制限制 | allow、ask、deny | src/kernel/permissions/permissionKernel.ts |
| WorkflowEngine | 创建/恢复 Run，执行节点和方向迁移，维护 checkpoint 与 artifact | WorkflowSession、WorkflowState | src/workflow/engine.ts |
| Node Runtime | 构建节点上下文、驱动模型与工具、校验 NodeResult | NodeResult、运行事件 | src/harness/runtime.ts |
| Provider Registry | 根据配置创建两类 Provider 并注入重试参数 | ModelProvider | src/providers/registry.ts |
| Tool Registry | 汇总本地、受管进程、Plan、MCP、Skill 工具 | Tool 列表与动态刷新 | src/tools/registry.ts |
| McpRuntime | 管理 Server 生命周期和 capability cache | tools、resources、prompts、diagnostics | src/mcp/runtime.ts |
| SkillRuntime | Skill 发现、激活、受约束 fork 和诊断 | ActivatedSkill、上下文注入 | src/skills/runtime.ts |
| SessionStore | Session 元数据、Transcript、Bus 路由、Plan 与审计 | SessionMetadata | src/storage/sessionStore.ts |
| RunStore | Run 元数据、事件、状态、对话、租约及审计投影 | WorkflowState、StoredEvent | src/storage/runStore.ts |
| ArtifactStore | 不可变 revision、索引、hash 校验和安全读取 | ArtifactRecord | src/storage/artifacts.ts |
| AuditStore | 带 hash 链与租约的追加审计日志 | audit.ndjson | src/audit/auditStore.ts |

## 9. 关键架构结论

1. **这是 conversation-first Kernel 与 Workflow 后端并存的单进程架构。** TUI 不直接执行节点；SessionExecutionBus 和 ExecutionCoordinator 是用户会话与编排后端之间的主要边界。
2. **KernelSession 是 Plan Mode 和交互暂停的状态核心。** WorkflowState 则是节点编排事实源，两者通过 workflowBinding、SessionStore 和 ExecutionCoordinator 关联。
3. **Workflow 与 Team 不是同一种路由模式。** Workflow 的 nodes 表示顺序，Team 的 nodes 表示候选成员；任何架构修改都必须保持这一差异。
4. **所有模型执行最终复用 TurnEngine。** 普通会话、Bus Dispatcher 和节点 Runtime 虽有不同提示与工具集，但共享 Provider 抽象、流式响应和重试语义。
5. **工具注册统一，权限入口尚未完全统一。** 本地工具、MCP 和 Skill 收敛到 ToolRegistry；普通会话经过 PermissionKernel，Workflow Node Runtime 则直接调用 checkToolPermission，因此修改权限语义时必须覆盖两条路径。
6. **可靠性主要建立在本地文件协议上。** 文件租约、串行写队列、原子 JSON、主备恢复、事件日志和不可变 artifact 共同承担崩溃恢复与审计。
7. **外部边界需要按风险分类。** 模型 API 和远程 MCP 是配置驱动外联；stdio MCP 和 ProcessStart 会创建子进程；WebFetch 对模型输入的 URL 执行 SSRF 防护；WebSearch 当前不可用。
8. **当前没有独立部署控制面。** 仓库未实现远程运行、远程恢复、云端同步或独立 headless 服务，不能把这些历史目标当作生产能力。

## 10. 架构变更评审检查项

后续修改核心路径时，至少复核以下不变量：

- TUI 是否仍只负责交互和投影，没有形成第二套 Kernel 或 Workflow 状态机。
- 新模型调用路径是否复用 Provider、TurnEngine 的超时、重试、usage 与审计语义。
- 新工具是否进入 ToolRegistry，并同时覆盖普通会话的 PermissionKernel 路径、节点运行时的 checkToolPermission 路径、事件账本和输出限制。
- 新写入是否具备明确路径边界、并发控制、崩溃恢复和敏感数据审计策略。
- Workflow 的固定顺序和 Team 的动态路由是否仍被严格区分。
- Plan Mode 是否仍只允许只读探索和当前 plan file 的限定写入。
- Session/Run schema 变化是否包含版本兼容、恢复测试和配置指纹影响分析。
- 新外联是否明确协议、凭据来源、超时、重试、SSRF/代理边界和失败隔离。
- 新后台任务是否受 ManagedProcessManager 管理，并能在完成、失败、中断时回收。
- 任何“已支持”的文档结论是否能从当前 src 和测试中找到直接证据。

## 11. 主要验证入口

架构相关测试按子系统分布于：

- tests/runtime：TurnEngine、ExecutionCoordinator、SessionExecutionBus 和输入队列。
- tests/kernel：KernelSession、PlanModeController、PermissionKernel 和 Tool Protocol。
- tests/workflow：Workflow/Team 执行、状态迁移、恢复和路由。
- tests/storage：Session、Run、Artifact、租约和项目存储。
- tests/providers：两类 Provider、HTTP 重试、认证头和流式协议。
- tests/mcp 与 tests/skills：配置、连接、延迟工具、资源、提示词和 Skill runtime。
- tests/security、tests/permissions、tests/harness：命令安全、路径边界和权限控制。
- tests/tui：交互渲染、Plan Mode、Bus 状态、恢复和 Workflow 选择。

本文是当前实现的架构快照。代码、配置结构或持久化协议发生实质变化时，应同步更新基线提交、相关图和组件追溯表。

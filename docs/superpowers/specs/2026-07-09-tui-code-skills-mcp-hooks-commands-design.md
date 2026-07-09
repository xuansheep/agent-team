# TUI Code Skills MCP Hooks Commands Design

日期：2026-07-09

## 背景

当前项目需要对齐参照源 `D:\work\code-ai\tui-code` 中的 `/skills`、`/mcp`、`/hooks` 能力。当前项目已经具备 MCP、Skill、Hook 的运行时、诊断输出和 TUI 交互基础，本设计选择在现有架构上做小幅扩展，不迁移参照源中与本目标无关的 plugin、OAuth/auth flow、`claudeai-proxy` 或 agent 分支。

本次范围必须做到真实状态变更。尤其 `/mcp enable` 与 `/mcp disable` 不能只修改界面状态，必须写回实际生效配置来源，并即时更新运行时状态。

## 目标

1. 新增 `/skills`，展示当前可见 skills 的只读浏览菜单。
2. 新增 `/hooks`，展示当前 hooks 配置的只读浏览菜单。
3. 新增 `/mcp`，展示 MCP server 管理菜单，支持 server、tools、tool schema 等详情浏览。
4. 支持 `/mcp reconnect server-name` 对指定 server 立即重连。
5. 支持 `/mcp enable [server-name]` 与 `/mcp disable [server-name]`，写回实际生效配置来源并即时更新运行时。
6. 保留当前项目既有运行时边界和测试方式，避免引入大范围架构迁移。

## 非目标

1. 不实现 plugin 管理。
2. 不实现 OAuth/auth flow。
3. 不实现 `claudeai-proxy` 相关行为。
4. 不迁移 tui-code 中 agent 或 plugin 相关分支。
5. `/skills` 与 `/hooks` 本轮只读，不提供安装、编辑、启停或删除入口。
6. 不强杀已经开始执行的 MCP tool call。本轮只保证禁用后阻止后续 tool、resource、prompt 暴露和调用。

## 方案选择

采用当前架构内的小幅扩展方案。

命令注册仍使用 `src/commands/registry.ts` 的静态命令表和 union 类型。补全仍通过 `src/tui/commandCompletion.ts` 扩展。TUI 仍由 `src/tui/TuiApp.tsx` 的 command 分支接收 slash command，并进入对应交互菜单。

菜单 UI 复用现有 `InteractionArea` 与 `CustomSelect`。菜单数据整理放入小模块，例如 `src/tui/commandMenus/skillsMenu.ts`、`src/tui/commandMenus/hooksMenu.ts`、`src/tui/commandMenus/mcpMenu.ts`。这些模块只负责把 diagnostics 或 runtime 数据转换为选项和详情文本，不直接修改运行时状态。

## 命令行为

### `/skills`

打开 skills 浏览菜单。默认按 source 分组展示 skill 列表。每个 skill 至少展示名称、来源、加载模式和路径。若 runtime diagnostics 已提供 description、whenToUse、allowedTools、hasHooks 等字段，则详情页展示这些字段。

空状态显示可读提示，说明当前没有可用 skills，而不是报错。

关闭菜单时向 transcript 写入 `Skills dialog dismissed`。

### `/hooks`

打开 hooks 浏览菜单。浏览路径为 event、matcher、hook、detail 四层。

第一层展示 hook event 以及数量。第二层展示 matcher 和该 matcher 下 hook 数量。第三层展示 hook id、type、source、wired、disabled 等状态。第四层展示 command、skillRoot、once、lastExecution、错误摘要等详情。

disabled hook 仍然显示，并明确标记 disabled。

关闭菜单时向 transcript 写入 `Hooks dialog dismissed`。

### `/mcp`

打开 MCP 管理菜单。默认展示当前合并后可见的 server 列表。每个 server 展示名称、来源、状态、错误摘要、tool/resource/prompt 数量以及 transport 类型。进入 server 后可查看 server 详情、tools 列表和 tool schema 详情。

菜单内可以提供 reconnect、enable、disable 动作，但这些动作必须调用同一套 MCP service，不在 UI 层直接改状态。

关闭菜单时向 transcript 写入 `MCP dialog dismissed`。

### `/mcp reconnect server-name`

对指定 server 立即重连。行为为先关闭当前连接和缓存，再按最新落盘后的合并配置重新连接。server 不存在时输出明确错误。server disabled 时不自动启用，提示需要先 enable。

### `/mcp enable [server-name]`

带 server 时，只启用该 server。不带 server 时，批量启用当前合并后可见的所有 server。

启用流程：

1. 解析当前合并配置和每个 server 的实际生效来源。
2. 修改实际生效来源中的 `disabled` 字段。推荐移除 `disabled` 字段；如果格式保持更稳，也可写为 `false`，但实现必须在测试中固定一种行为。
3. 写回成功后重新读取合并配置。
4. 对目标 server 调用运行时连接。
5. 连接失败时配置保持 enabled，runtime 状态显示 error，并展示失败原因。

### `/mcp disable [server-name]`

带 server 时，只禁用该 server。不带 server 时，批量禁用当前合并后可见的所有 server。

禁用流程：

1. 解析当前合并配置和每个 server 的实际生效来源。
2. 修改实际生效来源中的 `disabled: true`。
3. 写回成功后重新读取合并配置。
4. 关闭目标 server 的运行时连接，清理 capabilities、tools、resources、prompts 缓存。
5. 禁止后续暴露和调用该 server 的 tool、resource、prompt。

批量操作不做全局事务。部分失败时不回滚已成功项，但必须汇总成功列表、失败列表和失败原因。

## MCP 配置写回

当前 MCP 来源包括：

1. user：`~/.einsteins/mcp.json`
2. project：项目 `.mcp.json`
3. agent-team：`agent-team.yaml` 中的 `mcpServers`

合并优先级保持现状：agent-team 高于 project，高于 user。

写回规则：

1. 只修改 server 当前实际生效的来源。
2. 不修改低优先级中被遮蔽的同名 server。
3. 找不到 server 时不创建新 server。
4. JSON 文件通过 JSON parser 读写，不做字符串替换。
5. YAML 文件通过结构化 YAML parser 读写；如果当前项目没有可复用 helper，则新增窄 helper，只负责读取并修改 `mcpServers.server-name.disabled`。
6. 写回前后保留无关字段。
7. 所有文本写入遵守项目要求，实际落盘使用可靠写入流程，避免 PowerShell 直接写正文。

为了支持写回，需要在 `src/mcp/config.ts` 暴露或新增来源解析能力，使调用方可以知道每个合并后 server 的实际生效来源、来源路径和源格式。

## MCP 运行时扩展

`McpRuntime` 需要补充小范围运行时控制能力：

1. `disconnect(name)`：关闭指定 server 的 client，清理 tools/resources/prompts/capabilities 缓存，并把状态置为 disabled 或 disconnected。
2. `reconnect(name)`：按最新配置重连指定 server。行为应等价于 disconnect 后 connect。
3. diagnostics 增加菜单所需字段，例如 transport、source path、server config disabled 状态、tool schema 摘要等。
4. 禁用 server 后，任何聚合 tools、resources、prompts 的 API 都不能继续返回该 server 的能力。

运行时状态必须以落盘后的配置重新读取结果为准，不能只依赖 UI 内存状态。

## TUI 菜单状态

TUI 中新增轻量命令菜单状态，不引入第二套命令运行框架。

建议状态包括：

1. `skills:list`
2. `skills:detail`
3. `hooks:events`
4. `hooks:matchers`
5. `hooks:hooks`
6. `hooks:detail`
7. `mcp:list`
8. `mcp:server`
9. `mcp:tools`
10. `mcp:toolDetail`

交互规则：

1. Enter 进入下一层或执行当前选中动作。
2. Esc 返回上一层；在顶层 Esc 关闭菜单。
3. 菜单 footer 展示当前可用动作，例如 view、back、reconnect、enable、disable。
4. 操作失败时保留当前菜单上下文，并展示错误。
5. 命令完成或菜单关闭后向 transcript 写入简短结果。

## 错误处理

1. 写回失败：不更新运行时，展示来源路径和失败原因。
2. 写回成功但连接失败：配置保持 enabled，runtime 状态为 error，显示连接失败原因。
3. disable 后关闭连接失败：配置保持 disabled，后续能力不再暴露，同时显示关闭失败原因。
4. 批量操作：展示成功数、失败数和每个失败 server 的原因。
5. diagnostics 读取失败：菜单显示失败状态，不让 TUI 崩溃。
6. 未知参数，例如 `/mcp foo`：展示支持的用法，不当作普通 `/mcp` 菜单处理。

## 测试计划

1. `tests/commands/registry.test.ts`：覆盖 `/skills`、`/mcp`、`/hooks` 注册元数据。
2. `tests/tui/commandCompletion.test.ts`：覆盖新命令补全和 `/mcp enable|disable|reconnect` 参数补全。
3. `tests/mcp/config.test.ts`：覆盖 JSON/YAML 写回、来源优先级、同名 server 只改实际生效来源、找不到 server 不创建。
4. `tests/mcp/connectionManager.test.ts` 或新增 runtime 测试：覆盖 enable、disable、reconnect 对运行时状态和能力暴露的影响。
5. `tests/tui` 相关测试：覆盖 slash command 打开菜单、进入详情、取消关闭、错误提示。
6. `tests/skills/skillRuntime.test.ts` 与 `tests/hooks/runtime.test.ts`：仅在 diagnostics 补字段时增加对应断言。

最终验证命令包括 `npm run build:test` 和相关定向测试。若环境依赖导致命令无法完成，必须记录失败原因和剩余风险。

## 风险与约束

1. 配置写回是最高风险点。必须通过结构化 parser 修改，不允许字符串替换。
2. 多来源同名 server 容易误改。必须以合并后实际生效来源为唯一写回目标。
3. 批量 enable 可能造成多个外部连接失败。失败不能吞掉，也不能回滚已成功的配置修改。
4. TUI 菜单不能持有过期状态。涉及 enable、disable、reconnect 后必须刷新 diagnostics。
5. 本设计不取消已在执行中的 tool call；如果未来需要强取消，应另起设计。

## 验收标准

1. `/skills`、`/hooks`、`/mcp` 出现在 help、registry 和补全中。
2. `/skills` 能展示当前可见 skills，并能进入详情和关闭。
3. `/hooks` 能按 event、matcher、hook、detail 浏览，并标明 disabled 状态。
4. `/mcp` 能展示 server 状态、来源和 tools 详情。
5. `/mcp enable server-name` 会写回实际生效配置来源，并立即连接。
6. `/mcp disable server-name` 会写回实际生效配置来源，并立即停止暴露该 server 能力。
7. `/mcp enable` 与 `/mcp disable` 批量操作能逐个写回并汇总结果。
8. `/mcp reconnect server-name` 能按最新配置重连。
9. 相关自动化测试通过，未通过项必须有明确原因和风险说明。

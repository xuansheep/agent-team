# Agent Team CLI MVP 实现计划

**目标：** 构建一个 TypeScript CLI 版 MVP，用本地 Harness 运行可配置的 Agent 团队流程，支持 Claude Code 风格的工具调用、权限控制、运行日志、角色交接、失败返工、用户验收、最终交付、OpenAI-compatible Provider、图片理解输入和本地工具集。

**架构：** 系统是本地 CLI Harness。Claude Code 风格的运行时能力，包括 tool calling、权限判断、本地工具、会话持久化、中断恢复和上下文压缩，放在 `src/harness`。Agent 团队扩展能力，包括角色、流程节点、handoff、反馈边、用户验收和最终交付，放在 `src/team` 与 `src/workflow`。

**技术栈：** TypeScript、Node.js、npm、Vitest、Zod、Commander、js-yaml、fast-glob、undici、OpenAI-compatible Chat Completions API。

---

## 已确认设计决策

- MVP 形态：本地 CLI 加 `agent-team.yaml`，不做 Web UI。
- 流程模型：线性主流程加显式失败返工边。
- 角色模型：`Role Template` 与 `Workflow Node Instance` 分离。
- 节点输出：统一结构化 JSON envelope。
- 上下文传递：以下游可执行的 `handoff` 为入口，完整产出通过 references 和 artifacts 引用。
- 返工机制：下游节点和用户验收节点可以驳回上游节点声明的完成状态。
- 验证策略：MVP 不强制 Harness 校验证据，节点完成由模型自述，后续节点和用户验收负责驳回。
- Runtime 原则：Harness 行为默认参考 Claude Code。
- 权限模型：Claude Code 风格 `allow`、`ask`、`deny`，`deny` 优先；作用域为 workflow 基线权限加 node 权限。
- 工具集：本地 Claude Code 风格工具，工具名和参数语义尽量兼容。
- Provider：首版实现 OpenAI-compatible Adapter，支持 tool calling 和 vision capability 校验。
- 存储：本地 run 目录，包含 events、state 和 artifacts。
- 用户交互：节点可进入 `waiting_user`，用户补充后从同一节点恢复。
- 最终交付：内置只读职责的 `final_delivery` 节点，但实现上仍作为普通节点运行。

## 项目规格状态

`PROJECT_SPEC_INDEXES_FOUND`: none

`PROJECT_RULES_SUMMARY`: 当前仓库不存在 `docs/project-spec/` 下的规格索引。本计划基于仓库现状和上述已确认设计决策编写。

## 文件结构

需要创建这些文件：

```text
package.json
tsconfig.json
vitest.config.ts
agent-team.example.yaml
src/cli/main.ts
src/cli/commands/init.ts
src/cli/commands/run.ts
src/cli/commands/resume.ts
src/cli/commands/status.ts
src/cli/commands/inspect.ts
src/config/schema.ts
src/config/loadConfig.ts
src/config/resolveConfig.ts
src/harness/events.ts
src/harness/permissions.ts
src/harness/runtime.ts
src/harness/context.ts
src/harness/compaction.ts
src/providers/types.ts
src/providers/openaiCompatible.ts
src/providers/registry.ts
src/storage/runStore.ts
src/storage/artifacts.ts
src/team/nodeResult.ts
src/team/handoff.ts
src/tools/types.ts
src/tools/registry.ts
src/tools/local/read.ts
src/tools/local/write.ts
src/tools/local/edit.ts
src/tools/local/multiEdit.ts
src/tools/local/list.ts
src/tools/local/glob.ts
src/tools/local/grep.ts
src/tools/local/bash.ts
src/tools/local/powershell.ts
src/tools/local/todoWrite.ts
src/tools/local/attachImage.ts
src/tools/local/webFetch.ts
src/tools/local/webSearch.ts
src/workflow/engine.ts
src/workflow/state.ts
src/workflow/transitions.ts
tests/config/loadConfig.test.ts
tests/harness/permissions.test.ts
tests/storage/runStore.test.ts
tests/tools/localTools.test.ts
tests/providers/openaiCompatible.test.ts
tests/workflow/engine.test.ts
tests/cli.smoke.test.ts
```

MVP 不实现 Web UI、远程队列、生产部署 API、企业账号体系和可视化流程编辑器。

---

### 任务 1：项目脚手架

**文件：**
- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`vitest.config.ts`
- 创建：`src/cli/main.ts`

- [ ] **步骤 1：创建 package 元数据**

写入 `package.json`，要求：

- `type` 为 `module`
- `bin.agent-team` 指向 `dist/cli/main.js`
- scripts 包含 `build`、`test`、`test:watch`、`lint`
- dependencies 包含 `commander`、`@commander-js/extra-typings`、`fast-glob`、`js-yaml`、`undici`、`zod`
- devDependencies 包含 `typescript`、`vitest`、`@types/node`、`@types/js-yaml`

建议内容：

```json
{
  "name": "agent-team",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "agent-team": "dist/cli/main.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@commander-js/extra-typings": "^12.1.0",
    "commander": "^12.1.0",
    "fast-glob": "^3.3.2",
    "js-yaml": "^4.1.0",
    "undici": "^6.21.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **步骤 2：创建 TypeScript 配置**

写入 `tsconfig.json`，使用 `target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`、`outDir: dist`，并包含 `src/**/*.ts`、`tests/**/*.ts` 和 `vitest.config.ts`。

- [ ] **步骤 3：创建 Vitest 配置**

写入 `vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    restoreMocks: true
  }
});
```

- [ ] **步骤 4：创建 CLI 入口**

写入 `src/cli/main.ts`，创建 Commander 程序：名称 `agent-team`，版本 `0.1.0`，并预留 `init`、`run`、`resume`、`status`、`inspect` 命令注册。

- [ ] **步骤 5：验证脚手架**

运行：`npm install`

预期：依赖安装成功，并生成 `package-lock.json`。

运行：`npm run build`

预期：TypeScript 构建通过。

---

### 任务 2：配置 Schema 与加载

**文件：**
- 创建：`src/config/schema.ts`
- 创建：`src/config/loadConfig.ts`
- 创建：`src/config/resolveConfig.ts`
- 测试：`tests/config/loadConfig.test.ts`
- 创建：`agent-team.example.yaml`

- [ ] **步骤 1：编写失败测试**

测试两件事：

- 能加载合法的单文件 YAML 配置。
- 当 workflow node 引用不存在的 role 时抛错。

关键断言：

```ts
expect(config.providers.default.type).toBe("openai-compatible");
expect(config.workflows.delivery.nodes[0].id).toBe("product");
await expect(loadConfig(file)).rejects.toThrow("Unknown role developer");
```

- [ ] **步骤 2：实现 Zod schemas**

实现 `permissionSetSchema`、`providerSchema`、`roleSchema`、`nodeSchema`、`edgeSchema`、`workflowSchema` 和 `configSchema`。

权限结构必须是：

```ts
export const permissionSetSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([])
}).default({ allow: [], ask: [], deny: [] });
```

节点权限模式必须包含：

```ts
z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])
```

- [ ] **步骤 3：实现配置加载**

`loadConfig(path)` 读取 YAML，用 `configSchema` 解析，然后调用 `resolveConfig(config)`。

`resolveConfig(config)` 必须校验：

- 每个 node 引用的 role 存在。
- 每个 node 引用的 provider 存在。
- 每条 edge 的 `from` 和 `to` 都是已有 node。

- [ ] **步骤 4：添加示例配置**

创建 `agent-team.example.yaml`，包含：

- roles：`product`、`developer`、`tester`、`user_acceptance`、`final_delivery`
- workflow：`delivery`
- baseline deny：`.env`、`secrets/**`、危险 shell 命令
- edges：`product -> dev -> test -> user_acceptance -> final_delivery`
- failure edges：`test failure -> dev`、`user_acceptance failure -> product`

- [ ] **步骤 5：验证配置加载**

运行：`npm test -- tests/config/loadConfig.test.ts`

预期：PASS。

---
### 任务 3：Run 存储、事件日志与产物

**文件：**
- 创建：`src/harness/events.ts`
- 创建：`src/workflow/state.ts`
- 创建：`src/storage/runStore.ts`
- 创建：`src/storage/artifacts.ts`
- 测试：`tests/storage/runStore.test.ts`

- [ ] **步骤 1：编写失败测试**

测试 `RunStore.createRun("delivery", input)` 会创建 `.runs/{run_id}/artifacts`，初始化 `events.ndjson`，追加 `run_started` 事件，追加 `node_started` 事件，并保存 `state.json`。

关键断言：

```ts
expect(events).toContain("run_started");
expect(events).toContain("node_started");
expect(state.current_node_id).toBe("product");
```

- [ ] **步骤 2：实现事件类型**

创建 `HarnessEvent` 判别联合类型，覆盖：

```text
run_started
node_started
node_waiting_user
tool_invoked
tool_completed
tool_failed
artifact_created
node_completed
transition
run_completed
run_failed
```

创建：

```ts
export type StoredEvent = HarnessEvent & {
  ts: string;
  seq: number;
};
```

- [ ] **步骤 3：实现状态类型**

创建 `WorkflowState`：

```ts
type RunStatus = "running" | "waiting_user" | "completed" | "failed" | "interrupted";

type WorkflowState = {
  status: RunStatus;
  workflow_id: string;
  current_node_id?: string;
  attempts: Array<{
    node_id: string;
    attempt: number;
    status: "running" | "success" | "failure" | "waiting_user";
    result?: unknown;
  }>;
  handoff?: unknown;
};
```

- [ ] **步骤 4：实现 RunStore**

`RunStore` 必须暴露：

```ts
createRun(workflowId, input)
appendEvent(runId, event)
saveState(runId, state)
loadState(runId)
loadEvents(runId)
runDir(runId)
```

规则：

- events 是 append-only NDJSON。
- state 是 JSON 快照，概念上可以从 events 重建。
- run id 使用时间戳加 UUID。
- artifacts 位于 `.runs/{run_id}/artifacts/`。

- [ ] **步骤 5：实现 ArtifactStore**

`ArtifactStore` 支持：

```ts
writeText(nodeId, name, text)
copyInputImage(path)
```

输入图片复制到 `artifacts/input/`；节点产物写入 `artifacts/{node_id}/`。

- [ ] **步骤 6：验证存储层**

运行：`npm test -- tests/storage/runStore.test.ts`

预期：PASS。

---

### 任务 4：Claude Code 风格权限

**文件：**
- 创建：`src/harness/permissions.ts`
- 测试：`tests/harness/permissions.test.ts`

- [ ] **步骤 1：编写失败测试**

测试：

- `deny` 优先于 `allow`
- 只写工具名的 allow 能匹配
- `Bash(npm test *)` 这类 wildcard specifier 能匹配

关键用例：

```ts
decidePermission("Read", "./.env", {
  allow: ["Read"],
  ask: [],
  deny: ["Read(./.env)"]
});

decidePermission("LS", ".", {
  allow: ["LS"],
  ask: [],
  deny: []
});

decidePermission("Bash", "npm test -- tests/config/loadConfig.test.ts", {
  allow: ["Bash(npm test *)"],
  ask: [],
  deny: []
});
```

- [ ] **步骤 2：实现权限匹配器**

实现：

```ts
export type PermissionDecision = {
  decision: "allow" | "ask" | "deny";
  rule?: string;
};

export function decidePermission(
  tool: string,
  specifier: string,
  permissions: PermissionSet
): PermissionDecision;

export function mergePermissions(
  base: PermissionSet,
  node: PermissionSet
): PermissionSet;
```

匹配规则：

- 先检查 `deny`。
- 再检查 `ask`。
- 最后检查 `allow`。
- 规则形式为 `Tool` 或 `Tool(specifier)`。
- specifier 中 `*` 是 wildcard。
- 没有匹配项时返回 `{ decision: "ask" }`。
- workflow 级 deny 会进入合并后的 deny 列表，因此 node allow 不能越过全局 deny。

- [ ] **步骤 3：验证权限层**

运行：`npm test -- tests/harness/permissions.test.ts`

预期：PASS。

---

### 任务 5：本地工具协议与核心工具

**文件：**
- 创建：`src/tools/types.ts`
- 创建：`src/tools/registry.ts`
- 创建：`src/tools/local/` 下全部工具文件
- 测试：`tests/tools/localTools.test.ts`

- [ ] **步骤 1：编写失败测试**

测试：

- `Write`、`Edit`、`Read` 能在临时 workspace 中创建、修改和读取文件。
- `Bash` 能执行 `node --version` 并返回 `exit_code: 0`。

- [ ] **步骤 2：实现工具协议**

使用接口：

```ts
export type ToolContext = {
  cwd: string;
  runDir?: string;
};

export type ToolResult = {
  output?: string;
  error?: string;
  exit_code?: number;
  artifact_id?: string;
};

export type Tool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
};
```

- [ ] **步骤 3：实现工具注册表**

`ToolRegistry` 暴露：

```ts
add(tool)
get(name)
list()
```

`createLocalToolRegistry()` 注册：

```text
Read
Write
Edit
MultiEdit
LS
Glob
Grep
Bash
PowerShell
TodoWrite
AttachImage
WebFetch
WebSearch
```

- [ ] **步骤 4：实现本地工具**

工具行为：

- `Read`：读取 workspace 内 UTF-8 文本文件。
- `Write`：写入 UTF-8 文本文件，并创建父目录。
- `Edit`：替换一次精确字符串；如果 `old_string` 不存在则失败。
- `MultiEdit`：按顺序执行多个精确替换；写入前先确认所有 edit 都能应用。
- `LS`：列出目录条目。
- `Glob`：用 `fast-glob` 基于 `cwd` 返回相对路径。
- `Grep`：扫描 glob 命中的 UTF-8 文件，返回 `path:line:text` 行。
- `Bash`：执行 shell 命令，支持 timeout，使用 `windowsHide: true`。
- `PowerShell`：Windows 上执行 PowerShell；非 Windows 返回清晰 unsupported 错误。
- `TodoWrite`：如果存在 `runDir`，把 todo list 写入 run artifacts；否则返回序列化 todos。
- `AttachImage`：校验图片路径或 artifact 引用，返回 artifact metadata。
- `WebFetch`：通过 `undici` 抓取 URL 文本。
- `WebSearch`：注册工具名，但在未配置搜索 provider 时返回 unsupported。

- [ ] **步骤 5：验证工具层**

运行：`npm test -- tests/tools/localTools.test.ts`

预期：PASS。

---

### 任务 6：Provider Adapter、Tool Calling 与 Vision

**文件：**
- 创建：`src/providers/types.ts`
- 创建：`src/providers/openaiCompatible.ts`
- 创建：`src/providers/registry.ts`
- 测试：`tests/providers/openaiCompatible.test.ts`

- [ ] **步骤 1：编写 Provider 映射测试**

测试文本加图片内容会转换成 OpenAI-compatible `image_url`：

```ts
expect(messages[0].content).toEqual([
  { type: "text", text: "Review this design" },
  { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
]);
```

- [ ] **步骤 2：实现 Provider 类型**

创建：

```text
ModelContentPart
ModelMessage
ModelToolCall
ModelRequest
ModelResponse
ModelProvider
```

`ModelProvider` 暴露：

```ts
generate(request: ModelRequest): Promise<ModelResponse>;
```

- [ ] **步骤 3：实现 OpenAI-compatible Adapter**

`OpenAiCompatibleProvider.generate` 必须：

- POST 到 `{baseUrl}/chat/completions`
- 传入 messages
- 把本地工具映射成 OpenAI function tools
- 把返回的 tool calls 映射成 `{ id, name, input }`

- [ ] **步骤 4：实现 Provider Registry**

`createProvider(config, providerId)` 读取 provider 配置，解析 `api_key_env`，返回 `OpenAiCompatibleProvider`。缺少 API key 必须在节点启动前失败。

- [ ] **步骤 5：验证 Provider**

运行：`npm test -- tests/providers/openaiCompatible.test.ts`

预期：PASS。

---
### 任务 7：节点结果、Handoff 与上下文构建

**文件：**
- 创建：`src/team/nodeResult.ts`
- 创建：`src/team/handoff.ts`
- 创建：`src/harness/context.ts`
- 创建：`src/harness/compaction.ts`

- [ ] **步骤 1：实现节点结果 Schema**

使用 Zod schema，状态只允许：

```text
success
failure
needs_user_input
```

必需输出结构：

```ts
{
  status: "success" | "failure" | "needs_user_input";
  summary: string;
  deliverables: Array<{ artifact_id: string; description: string }>;
  feedback: { defects: string[]; change_requests: string[] };
  questions: Array<{ id: string; text: string; required: boolean }>;
  handoff: {
    instruction: string;
    must_follow: string[];
    known_risks: string[];
    open_questions: string[];
  };
}
```

实现 `parseNodeResult(text)`，必须先 JSON.parse，再做 schema 校验。

- [ ] **步骤 2：实现 handoff context**

`buildHandoff(to, from, result, iteration)` 返回：

```ts
{
  from,
  to,
  instruction: result.handoff.instruction || result.summary,
  references: [
    {
      node_id: from ?? "input",
      summary: result.summary,
      artifact_ids: result.deliverables.map((item) => item.artifact_id)
    }
  ],
  feedback: result.feedback,
  iteration
}
```

- [ ] **步骤 3：实现节点消息构建**

`buildNodeMessages(node, systemPrompt, handoff)` 返回：

- system message：角色提示词
- user message：格式化 JSON，包含 `{ node_id, handoff }`

- [ ] **步骤 4：实现上下文压缩占位能力**

`compactMessages(messages)`：

- 当 messages 数量小于等于 20 时原样返回。
- 超过 20 时保留第一条 system message 和最近 19 条消息。

这是 Claude Code 风格自动压缩的接口占位，MVP 不做模型摘要压缩。

- [ ] **步骤 5：验证构建**

运行：`npm run build`

预期：PASS。

---

### 任务 8：Harness Runtime Loop

**文件：**
- 创建：`src/harness/runtime.ts`
- 修改：`src/storage/runStore.ts`
- 测试：`tests/workflow/engine.test.ts`

- [ ] **步骤 1：通过 WorkflowEngine 编写 runtime 行为测试**

使用 fake provider 返回：

```json
{"status":"success","summary":"done","handoff":{"instruction":"next"}}
```

断言两节点 workflow 可以按顺序完成，并记录两个 node attempts。

- [ ] **步骤 2：实现 runtime loop**

`runNode(options)` 必须：

- 基于 system prompt 和 handoff 构建模型消息。
- 把 messages 和 tool schemas 发送给 provider。
- 如果 provider 返回 tool calls，计算 permission specifier，执行 `decidePermission`，执行允许的工具，追加 tool events，并把 tool result 回传给模型。
- 如果 provider 返回 content，把它解析为 `NodeResult` 并返回。
- 如果 content 和 tool calls 都没有，直接失败。

Tool specifier 规则：

- `Bash` 和 `PowerShell`：使用 `input.command`
- 文件工具：使用 `input.file_path`
- 路径工具：使用 `input.path`
- 网络工具：使用 `input.url`

- [ ] **步骤 3：处理权限决策**

Runtime 行为：

- `deny`：抛出 `Permission denied for {tool}`，并追加失败事件。
- `allow`：执行工具。
- `ask`：MVP 抛出 `Permission ask is not interactive in this MVP for {tool}`。保留 `ask` 是为了维持 Claude Code 风格权限模型，但首版不实现交互式授权。

- [ ] **步骤 4：通过 workflow 测试验证 runtime**

运行：`npm test -- tests/workflow/engine.test.ts`

预期：在任务 9 实现 WorkflowEngine 前失败；任务 9 完成后通过。

---

### 任务 9：Workflow Engine 与流程跳转

**文件：**
- 创建：`src/workflow/transitions.ts`
- 创建：`src/workflow/engine.ts`
- 修改：`tests/workflow/engine.test.ts`

- [ ] **步骤 1：实现 transitions**

`firstNodeId(workflow)`：返回没有被任何 edge 指向的 node；如果找不到，则返回配置中的第一个 node。

`nextNodeId(workflow, from, status)`：返回第一条匹配 `{ from, condition: status }` 的 edge 的 `to`。

- [ ] **步骤 2：实现 WorkflowEngine**

`WorkflowEngine.run(config, workflowId, input)` 必须：

- 创建 run 目录。
- 初始化本地工具集。
- 解析 workflow 级 baseline permissions。
- 从 `firstNodeId` 开始运行。
- 对每个 node 校验 role 和 provider capabilities。
- 调用 `runNode` 执行节点。
- 当结果为 `needs_user_input` 时，保存 `waiting_user` 状态并返回。
- 当结果为 `success` 或 `failure` 时，记录 node completion，选择下一条 edge，并构建 handoff。
- success 后没有下一条 edge，则 run completed。
- failure 后没有下一条 edge，则 run failed。

- [ ] **步骤 3：增加失败返工边测试**

fake provider 行为：

- `dev` 第一次 success
- `test` 第一次 failure
- `dev` 第二次 success
- `test` 第二次 success
- `final_delivery` success

断言：

```ts
expect(result.status).toBe("completed");
expect(result.attempts.filter((attempt) => attempt.node_id === "dev")).toHaveLength(2);
```

- [ ] **步骤 4：验证工作流**

运行：`npm test -- tests/workflow/engine.test.ts`

预期：PASS。

---

### 任务 10：CLI 命令

**文件：**
- 修改：`src/cli/main.ts`
- 创建：`src/cli/commands/init.ts`
- 创建：`src/cli/commands/run.ts`
- 创建：`src/cli/commands/resume.ts`
- 创建：`src/cli/commands/status.ts`
- 创建：`src/cli/commands/inspect.ts`

- [ ] **步骤 1：注册命令**

`main.ts` 导入并调用：

```ts
registerInitCommand(program);
registerRunCommand(program);
registerResumeCommand(program);
registerStatusCommand(program);
registerInspectCommand(program);
```

- [ ] **步骤 2：实现 `init`**

`agent-team init` 把 `agent-team.example.yaml` 复制为 `agent-team.yaml`，并输出：

```text
Created agent-team.yaml
```

- [ ] **步骤 3：实现 `run`**

命令形态：

```bash
agent-team run -f agent-team.yaml --workflow delivery --input "..." --image ./design.png
```

行为：

- 加载配置。
- 创建 `WorkflowEngine`。
- 注入 `createProvider`。
- 打印格式化 JSON 状态。

- [ ] **步骤 4：实现 `status`**

`agent-team status {run_id}` 读取 `.runs/{run_id}/state.json` 并输出。

- [ ] **步骤 5：实现 `inspect`**

`agent-team inspect {run_id}` 读取 `.runs/{run_id}/events.ndjson` 并输出。

- [ ] **步骤 6：实现初版 `resume` 命令壳**

命令形态：

```bash
agent-team resume {run_id} -f agent-team.yaml --workflow delivery --answer "..."
```

在任务 11 前，可以输出明确消息说明 resume 状态机将在下一任务接入。任务 11 必须替换为真实 resume 行为。

- [ ] **步骤 7：验证 CLI 构建**

运行：`npm run build`

预期：PASS。

运行：`node dist/cli/main.js --help`

预期：输出包含 `init`、`run`、`resume`、`status`、`inspect`。

---
### 任务 11：Resume 与 waiting_user 继续执行

**文件：**
- 修改：`src/workflow/engine.ts`
- 修改：`src/storage/runStore.ts`
- 修改：`src/cli/commands/resume.ts`
- 测试：`tests/workflow/engine.test.ts`

- [ ] **步骤 1：增加 resume 测试**

Provider 第一次返回：

```json
{"status":"needs_user_input","summary":"need detail","questions":[{"id":"q1","text":"What is the target user?","required":true}]}
```

resume 后 provider 返回：

```json
{"status":"success","summary":"accepted answer","handoff":{"instruction":"continue"}}
```

断言：

- 同一个 node 被恢复执行。
- 用户 answer 被放入 handoff。
- 最终状态为 `completed`。

- [ ] **步骤 2：扩展 RunStore**

增加：

```ts
runDir(runId): string;
loadEvents(runId): Promise<StoredEvent[]>;
```

确保 `loadState(runId)` 返回 `WorkflowState`。

- [ ] **步骤 3：实现 `WorkflowEngine.resume`**

`resume(config, workflowId, runId, userInput)` 必须：

- 加载保存的 state。
- 要求 `state.status === "waiting_user"`。
- 使用 `state.current_node_id` 作为继续执行的节点。
- 构建 resumed handoff，包含之前的 handoff 和 `{ user_input: userInput }`。
- 从同一个节点继续执行。

- [ ] **步骤 4：接入 CLI resume**

`resume` 命令加载配置，创建 provider factory，调用 `engine.resume`，并输出格式化 JSON 状态。

- [ ] **步骤 5：验证 resume**

运行：`npm test -- tests/workflow/engine.test.ts`

预期：PASS。

---

### 任务 12：图片 Artifact 流程

**文件：**
- 修改：`src/cli/commands/run.ts`
- 修改：`src/storage/artifacts.ts`
- 修改：`src/harness/context.ts`
- 修改：`src/providers/openaiCompatible.ts`
- 测试：`tests/providers/openaiCompatible.test.ts`
- 测试：`tests/workflow/engine.test.ts`

- [ ] **步骤 1：增加图片输入测试**

测试：

- CLI 传入的本地图片路径会复制到 run artifacts。
- 初始 handoff 中只保存 artifact 引用。
- Provider 转换时把图片内容转成 OpenAI-compatible base64 `image_url`。

- [ ] **步骤 2：复制输入图片**

第一个节点执行前，把每个 `--image` 路径复制到：

```text
.runs/{run_id}/artifacts/input/
```

handoff 中只保存：

```ts
artifact_id
copied_path
media_type
```

- [ ] **步骤 3：把 artifact 引用转换成模型 content parts**

当 handoff 包含 image artifacts 时，`buildNodeMessages` 读取 artifact bytes，base64 编码，并把 user content 变成数组：

```ts
{ type: "text", text: JSON.stringify({ node_id: node.id, handoff }, null, 2) }
{ type: "image", media_type: "image/png", data: "base64-data" }
```

- [ ] **步骤 4：强制 vision capability 校验**

如果 handoff 包含图片，但 provider capability `vision` 为 false，则节点执行前失败：

```text
Node {node_id} requires vision
```

- [ ] **步骤 5：验证图片流程**

运行：`npm test -- tests/providers/openaiCompatible.test.ts tests/workflow/engine.test.ts`

预期：PASS。

---

### 任务 13：Final Delivery 节点默认行为

**文件：**
- 修改：`src/workflow/engine.ts`
- 修改：`agent-team.example.yaml`
- 测试：`tests/workflow/engine.test.ts`

- [ ] **步骤 1：增加 final delivery 行为测试**

创建 workflow：

```text
dev -> user_acceptance -> final_delivery
```

fake provider 对所有节点返回 success。断言 run 只有在 `final_delivery` 成功后才进入 completed。

- [ ] **步骤 2：保持 final_delivery 为普通节点**

不要在 engine 中硬编码 `final_delivery`。它是普通 node，只是通过 role prompt 和 permissions 让它承担只读总结职责。

- [ ] **步骤 3：校验示例配置**

确认 `agent-team.example.yaml` 中 `final_delivery` 只有读权限：

```text
Read
LS
Glob
```

不得包含 write、edit、bash 类权限。

- [ ] **步骤 4：验证 final delivery**

运行：`npm test -- tests/workflow/engine.test.ts`

预期：PASS。

---

### 任务 14：CLI 冒烟测试与 README

**文件：**
- 修改：`README.md`
- 创建：`tests/cli.smoke.test.ts`

- [ ] **步骤 1：编写 CLI 冒烟测试**

先 build，再运行：

```bash
node dist/cli/main.js --help
```

断言输出包含：

```text
init
run
resume
status
inspect
```

- [ ] **步骤 2：更新 README**

README 必须包含：

```markdown
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
```

说明：README 中代码标识符和命令保持英文，解释文字可以继续补充中文。

- [ ] **步骤 3：完整验证**

运行：`npm run build`

预期：PASS。

运行：`npm test`

预期：PASS。

---

## 实施注意事项

- 每个任务按 TDD 执行：先写失败测试，再运行确认失败，再实现最小代码，再运行确认通过。
- 除非测试迫使拆分，不要增加本计划之外的新抽象。
- Provider 相关代码集中在 `src/providers/openaiCompatible.ts`。
- Workflow 语义集中在 `src/workflow`。
- 模型与工具调用循环集中在 `src/harness`。
- Claude Code 兼容要务实：工具名、输入语义、权限判断、runtime loop 和错误分类比终端 UI 复刻更重要。
- 不要宣称生产级验证能力。MVP 明确采用模型自述完成，下游节点和用户验收负责驳回。
- 不要实现破坏性清理命令。任何删除操作都必须在实现前单独获得用户明确同意。

## 自检结果

- 规格覆盖：本计划覆盖 CLI MVP、配置加载、role/node 分离、workflow transitions、handoff、反馈返工、waiting user、final delivery、OpenAI-compatible provider、图片输入、本地工具、Claude Code 风格权限、run log、state 和 artifacts。
- 已知有意缺口：MVP 不强制独立验证证据，因为已确认设计是节点由模型自述完成，后续节点和用户验收负责反馈。
- 已知有意缺口：不实现 Claude 云端或账号依赖工具，只实现本地工具和本地兼容协议。
- 占位扫描：没有常见占位标记，也没有未归属的顶层子系统。详细实现已拆成任务文件和验证命令。
- 类型一致性：Config、permissions、provider、tool、state、node result、handoff、workflow engine 的命名在任务之间保持一致。

## 执行交接

计划已保存到 `docs/mvp-implementation-plan.md`。

执行选项：

1. Subagent-Driven，推荐：每个任务派发一个新 subagent，任务之间 review，迭代更快。
2. Inline Execution：在当前会话中按计划逐步实现。
3. Yes, implement the plan by Claude。

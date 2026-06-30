# Tool Protocol Plan Mode Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前项目的 Plan Mode 重构为工具协议驱动的 Kernel 能力，让 TUI、SDK、headless、workflow 共享同一套 session、权限、工具协议和 pending interaction 流程。

**Architecture:** 新增 `src/kernel/*` 作为 conversation-first 内核层；先用 adapter 包住现有 `runtime`、`tools`、`plans`、`workflow`，再把 Plan Mode 主状态机从 TUI 和 workflow 局部分支迁入 Kernel。当前 workflow 保留为 approved plan 后的执行后端，所有模型 turn 与工具调用必须通过 `QueryEngine`、`ToolProtocol` 和 `PermissionKernel`。

**Tech Stack:** TypeScript `NodeNext`、Node built-in test runner、React/Ink TUI、现有 provider/runtime/workflow/local tools。

---

## Scope Check

该 spec 涉及 Kernel、工具协议、权限、Plan Mode、workflow backend、TUI、SDK/headless 七个强依赖子系统。它们不能拆成互不相关的项目，因为目标正是消除这些子系统里的 Plan Mode 分裂状态。本计划按可验证阶段切分，每个任务都能独立编译和测试。

## File Structure

Create:
- `src/kernel/session.ts`：`KernelSession`、`KernelStatus`、`PendingInteraction`、reducer、AppState 投影。
- `src/kernel/tools/protocol.ts`：`KernelTool` 协议和现有 `Tool` adapter。
- `src/kernel/tools/registry.ts`：mode-aware visible tools。
- `src/kernel/permissions/permissionKernel.ts`：统一权限入口。
- `src/kernel/plan/planModeController.ts`：enter、exit、approval、reject、handoff、plan hash。
- `src/kernel/queryEngine.ts`：模型 turn 与 tool loop 内核。
- `src/kernel/workflow/workflowBackend.ts`：approved plan 到 workflow engine 的幂等适配。
- `src/tui/kernelAdapter.ts`：TUI 与 KernelSession 的投影适配。

Modify:
- `src/tools/registry.ts`：Plan Mode 可见工具包含 `Write`、`Edit`、`MultiEdit`、`TodoWrite`、`ExitPlanMode`。
- `src/runtime/turnExecutor.ts`：逐步委托 `QueryEngine`、`KernelToolRegistry`、`PermissionKernel`。
- `src/plans/planSession.ts`：保留纯函数，作为 `PlanModeController` 底层能力。
- `src/sdk/localSession.ts`、`src/sdk/headless.ts`：共享 KernelSession。
- `src/workflow/engine.ts`：暴露 `WorkflowBackend` adapter。
- `src/tui/TuiApp.tsx`、`src/tui/components/PlanReviewPrompt.tsx`：渲染 Kernel pending interaction。

---

### Task 1: Kernel Session State

**Files:**
- Create: `src/kernel/session.ts`
- Test: `tests/kernel/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/kernel/session.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession, projectAppState, reduceKernelSession } from "../../src/kernel/session.js";

const permissions = { mode: "default" as const, allow: [], ask: [], deny: [] };

describe("KernelSession", () => {
  it("stores one pending plan approval", () => {
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions });
    const next = reduceKernelSession(session, {
      type: "pending_interaction_set",
      interaction: { type: "plan_approval", id: "approval-1", sessionId: "s1", planFilePath: ".session/plans/s1.md", document: "# Plan\n" }
    });

    assert.equal(next.status, "waiting_plan_approval");
    assert.equal(next.pendingInteraction?.type, "plan_approval");
    assert.equal(projectAppState(next).messageCount, 0);
  });
});
```

- [ ] **Step 2: Run it and verify failure**

Run: `npm run build:test && node dist-test/tests/kernel/session.test.js`
Expected: compile fails because `src/kernel/session.ts` does not exist.

- [ ] **Step 3: Implement `src/kernel/session.ts`**

```ts
import type { ModelMessage } from "../providers/types.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import type { PlanRequestedPermission, PlanSessionState } from "../plans/planSession.js";

export type KernelStatus = "idle_input" | "running_query" | "planning" | "waiting_tool_permission" | "waiting_user_input" | "waiting_plan_approval" | "running_workflow" | "interrupted_restoring";

export type PendingInteraction =
  | { type: "tool_permission"; id: string; sessionId: string; runId?: string; tool: string; input: unknown; reason?: string; rule?: string }
  | { type: "ask_user_question"; id: string; sessionId: string; runId?: string; toolCallId: string; questions: unknown[] }
  | { type: "plan_approval"; id: string; sessionId: string; document: string; planFilePath: string; empty?: boolean; requestedPermissions?: PlanRequestedPermission[] }
  | { type: "interrupt_confirmation"; id: string; sessionId: string; message: string };

export type WorkflowBinding = { runId: string; status: "pending" | "running" | "waiting" | "completed"; approvalId?: string; planHash?: string };
export type KernelSession = { id: string; cwd: string; status: KernelStatus; messages: ModelMessage[]; toolPermissionContext: ToolPermissionContext; planState: PlanSessionState | null; workflowBinding: WorkflowBinding | null; pendingInteraction: PendingInteraction | null };
export type KernelAction =
  | { type: "status_set"; status: KernelStatus }
  | { type: "messages_set"; messages: ModelMessage[] }
  | { type: "permissions_set"; permissions: ToolPermissionContext }
  | { type: "plan_state_set"; planState: PlanSessionState | null }
  | { type: "workflow_binding_set"; workflowBinding: WorkflowBinding | null }
  | { type: "pending_interaction_set"; interaction: PendingInteraction }
  | { type: "pending_interaction_cleared"; status?: KernelStatus };

export function createKernelSession(input: { id: string; cwd: string; permissions: ToolPermissionContext; messages?: ModelMessage[] }): KernelSession {
  return { id: input.id, cwd: input.cwd, status: "idle_input", messages: input.messages?.slice() ?? [], toolPermissionContext: { ...input.permissions }, planState: null, workflowBinding: null, pendingInteraction: null };
}

export function reduceKernelSession(session: KernelSession, action: KernelAction): KernelSession {
  if (action.type === "status_set") return { ...session, status: action.status };
  if (action.type === "messages_set") return { ...session, messages: action.messages.slice() };
  if (action.type === "permissions_set") return { ...session, toolPermissionContext: { ...action.permissions } };
  if (action.type === "plan_state_set") return { ...session, planState: action.planState };
  if (action.type === "workflow_binding_set") return { ...session, workflowBinding: action.workflowBinding };
  if (action.type === "pending_interaction_set") return { ...session, pendingInteraction: action.interaction, status: statusFor(action.interaction) };
  return { ...session, pendingInteraction: null, status: action.status ?? "idle_input" };
}

export function projectAppState(session: KernelSession) {
  return { id: session.id, status: session.status, pendingInteraction: session.pendingInteraction, planState: session.planState, workflowBinding: session.workflowBinding, messageCount: session.messages.length };
}

function statusFor(interaction: PendingInteraction): KernelStatus {
  if (interaction.type === "tool_permission") return "waiting_tool_permission";
  if (interaction.type === "ask_user_question") return "waiting_user_input";
  if (interaction.type === "plan_approval") return "waiting_plan_approval";
  return "interrupted_restoring";
}
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && node dist-test/tests/kernel/session.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/kernel/session.ts tests/kernel/session.test.ts && git commit -m "task-none:新增Kernel会话状态"`


---

### Task 2: Tool Protocol and Registry

**Files:**
- Create: `src/kernel/tools/protocol.ts`
- Create: `src/kernel/tools/registry.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/kernel/toolProtocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/kernel/toolProtocol.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { adaptToolToKernelTool } from "../../src/kernel/tools/protocol.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";

describe("Kernel tool protocol", () => {
  it("adapts existing tools and keeps plan write tools visible", async () => {
    const read = adaptToolToKernelTool(createLocalToolRegistry().get("Read"));
    assert.equal(read.name, "Read");
    assert.equal(await read.isReadOnly({ file_path: "package.json" }, { cwd: process.cwd() }), true);

    const names = createKernelToolRegistry(createLocalToolRegistry())
      .visibleTools({ mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" })
      .map((tool) => tool.name);
    assert.equal(names.includes("Write"), true);
    assert.equal(names.includes("Edit"), true);
    assert.equal(names.includes("MultiEdit"), true);
    assert.equal(names.includes("ExitPlanMode"), true);
  });
});
```

- [ ] **Step 2: Run it and verify failure**

Run: `npm run build:test && node dist-test/tests/kernel/toolProtocol.test.js`
Expected: compile fails because kernel tool files do not exist.

- [ ] **Step 3: Implement `src/kernel/tools/protocol.ts`**

```ts
import type { Tool, ToolContext, ToolResult } from "../../tools/types.js";

export type KernelUserInteractionRequest = { type: "ask_user_question"; questions?: unknown[] } | { type: "plan_approval" };

export type KernelTool<TInput = unknown, TResult extends ToolResult = ToolResult> = {
  name: string;
  description: string;
  prompt?: string | (() => string);
  input_schema: Record<string, unknown>;
  shouldDefer(input: TInput, context: ToolContext): boolean | Promise<boolean>;
  isReadOnly(input: TInput, context: ToolContext): boolean | Promise<boolean>;
  requiresUserInteraction(input: TInput, context: ToolContext): KernelUserInteractionRequest | null | Promise<KernelUserInteractionRequest | null>;
  validateInput(input: unknown, context: ToolContext): Promise<{ result: true; input: TInput } | { result: false; message: string }>;
  execute(input: TInput, context: ToolContext): Promise<TResult>;
  mapToolResultToModelResult(result: TResult, context: ToolContext): unknown;
  legacyTool: Tool;
};

export function adaptToolToKernelTool(tool: Tool): KernelTool {
  return {
    name: tool.name,
    description: tool.description,
    prompt: tool.prompt,
    input_schema: tool.input_schema,
    shouldDefer: () => false,
    isReadOnly: async (input, context) => await tool.isReadOnly?.(input, context) === true,
    requiresUserInteraction: async (input) => {
      if (await tool.requiresUserInteraction?.(input) !== true) return null;
      if (tool.name === "AskUserQuestion") return { type: "ask_user_question", questions: questionList(input) };
      if (tool.name === "ExitPlanMode") return { type: "plan_approval" };
      return { type: "ask_user_question" };
    },
    validateInput: async (input, context) => {
      const validation = await tool.validateInput?.(input, context);
      if (validation && !validation.result) return validation;
      return { result: true, input };
    },
    execute: (input, context) => tool.execute(input, context),
    mapToolResultToModelResult: (result) => tool.mapToolResultToModelResult?.(result) ?? result,
    legacyTool: tool
  };
}

function questionList(input: unknown): unknown[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const questions = (input as { questions?: unknown }).questions;
  return Array.isArray(questions) ? questions : undefined;
}
```

- [ ] **Step 4: Implement `src/kernel/tools/registry.ts`**

```ts
import type { ToolPermissionContext } from "../../permissions/context.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { adaptToolToKernelTool, type KernelTool } from "./protocol.js";

const planModeVisibleTools = new Set(["Read", "List", "Glob", "Grep", "WebFetch", "WebSearch", "Write", "Edit", "MultiEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode"]);

export class KernelToolRegistry {
  private readonly tools = new Map<string, KernelTool>();

  add(tool: KernelTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): KernelTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool;
  }

  list(): KernelTool[] { return [...this.tools.values()]; }

  visibleTools(context: ToolPermissionContext): KernelTool[] {
    if (context.mode !== "plan") return this.list();
    return this.list().filter((tool) => planModeVisibleTools.has(tool.name));
  }
}

export function createKernelToolRegistry(legacy: ToolRegistry): KernelToolRegistry {
  const registry = new KernelToolRegistry();
  for (const tool of legacy.list()) registry.add(adaptToolToKernelTool(tool));
  return registry;
}
```

- [ ] **Step 5: Modify `src/tools/registry.ts` Plan Mode registry**

Replace `createPlanModeToolRegistry` with:

```ts
export function createPlanModeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [readTool, writeTool, editTool, multiEditTool, lsTool, globTool, grepTool, webFetchTool, webSearchTool, todoWriteTool, askUserQuestionTool, exitPlanModeTool]) {
    registry.add(tool);
  }
  return registry;
}
```

- [ ] **Step 6: Verify**

Run: `npm run build:test && node dist-test/tests/kernel/toolProtocol.test.js && node dist-test/tests/plans/planMode.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

Run: `git add src/kernel/tools/protocol.ts src/kernel/tools/registry.ts src/tools/registry.ts tests/kernel/toolProtocol.test.ts && git commit -m "task-none:新增工具协议适配层"`

---

### Task 3: Permission Kernel

**Files:**
- Create: `src/kernel/permissions/permissionKernel.ts`
- Test: `tests/kernel/permissionKernel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/kernel/permissionKernel.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";
import { PermissionKernel } from "../../src/kernel/permissions/permissionKernel.js";
import { enterPlanMode } from "../../src/plans/planSession.js";

async function workspace() { return mkdtemp(join(tmpdir(), "agent-team-permission-kernel-")); }

describe("PermissionKernel", () => {
  it("allows only current plan file writes in plan mode", async () => {
    const cwd = await workspace();
    const tools = createKernelToolRegistry(createLocalToolRegistry());
    const entered = enterPlanMode({ sessionId: "s1", cwd, originalInput: { request: "build" }, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const kernel = new PermissionKernel();

    assert.equal((await kernel.check(tools.get("Write"), { file_path: entered.state.planFilePath, content: "# Plan" }, { ...entered.permissions, cwd })).decision, "allow");
    assert.equal((await kernel.check(tools.get("Write"), { file_path: "src/index.ts", content: "x" }, { ...entered.permissions, cwd })).decision, "deny");
    assert.equal((await kernel.check(tools.get("PowerShell"), { command: "Get-ChildItem" }, { ...entered.permissions, cwd })).decision, "deny");
  });
});
```

- [ ] **Step 2: Run it and verify failure**

Run: `npm run build:test && node dist-test/tests/kernel/permissionKernel.test.js`
Expected: compile fails because `PermissionKernel` does not exist.

- [ ] **Step 3: Implement `src/kernel/permissions/permissionKernel.ts`**

```ts
import { checkToolPermission } from "../../permissions/checkToolPermission.js";
import type { ToolPermissionCheckContext, ToolPermissionDecision } from "../../permissions/context.js";
import type { KernelTool } from "../tools/protocol.js";

export class PermissionKernel {
  async check(tool: KernelTool, input: unknown, context: ToolPermissionCheckContext): Promise<ToolPermissionDecision> {
    return checkToolPermission(tool.legacyTool, input, context);
  }
}
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && node dist-test/tests/kernel/permissionKernel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/kernel/permissions/permissionKernel.ts tests/kernel/permissionKernel.test.ts && git commit -m "task-none:统一工具权限入口"`


---

### Task 4: Plan Mode Controller

**Files:**
- Create: `src/kernel/plan/planModeController.ts`
- Test: `tests/kernel/planModeController.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/kernel/planModeController.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKernelSession } from "../../src/kernel/session.js";
import { PlanModeController } from "../../src/kernel/plan/planModeController.js";
import { readPlan } from "../../src/plans/planFiles.js";

async function workspace() { return mkdtemp(join(tmpdir(), "agent-team-plan-controller-")); }

describe("PlanModeController", () => {
  it("uses plan file as approval source", async () => {
    const cwd = await workspace();
    const session = createKernelSession({ id: "s1", cwd, permissions: { mode: "default", allow: [], ask: [], deny: [] } });
    const controller = new PlanModeController();
    const planning = controller.enterPlanMode(session, { request: "build" });
    const waiting = await controller.requestPlanApproval(planning, { plan: "# Plan\n\nShip safely." });

    assert.equal(waiting.status, "waiting_plan_approval");
    assert.equal(waiting.pendingInteraction?.type, "plan_approval");
    assert.equal(await readPlan(planning.planState!.planFilePath), "# Plan\n\nShip safely.");
  });
});
```

- [ ] **Step 2: Run it and verify failure**

Run: `npm run build:test && node dist-test/tests/kernel/planModeController.test.js`
Expected: compile fails because controller does not exist.

- [ ] **Step 3: Implement `src/kernel/plan/planModeController.ts`**

```ts
import { createHash, randomUUID } from "node:crypto";
import { approvePlan, buildApprovedPlanHandoff as buildLegacyHandoff, enterPlanMode, exitPlanMode, resolvePlanApproval } from "../../plans/planSession.js";
import { readPlan, writePlan } from "../../plans/planFiles.js";
import type { KernelSession } from "../session.js";
import { reduceKernelSession } from "../session.js";

export type ExitPlanModeRequest = { plan?: string; requestedPermissions?: { tool: string; prompt: string }[] };
export type ApprovedPlanHandoff = { sessionId: string; approvalId: string; planFilePath: string; planText: string; planHash: string; originalInput: unknown; legacyHandoff: unknown };

export class PlanModeController {
  enterPlanMode(session: KernelSession, originalInput: unknown): KernelSession {
    const entered = enterPlanMode({ sessionId: session.id, cwd: session.cwd, originalInput, permissions: session.toolPermissionContext });
    return { ...session, status: "planning", planState: entered.state, toolPermissionContext: entered.permissions };
  }

  async requestPlanApproval(session: KernelSession, request: ExitPlanModeRequest = {}): Promise<KernelSession> {
    if (!session.planState || session.planState.mode !== "planning") throw new Error("Plan Mode is not active");
    if (request.plan !== undefined) await writePlan(session.planState.planFilePath, request.plan);
    const exited = await exitPlanMode(session.planState, { requestedPermissions: request.requestedPermissions });
    return reduceKernelSession({ ...session, planState: exited.state }, {
      type: "pending_interaction_set",
      interaction: { type: "plan_approval", id: randomUUID(), sessionId: session.id, document: exited.plan.document, planFilePath: exited.plan.planFilePath, empty: exited.plan.empty, requestedPermissions: exited.plan.requestedPermissions }
    });
  }

  resolvePlanApproval(session: KernelSession, input: { decision: "continue" | "stay"; feedback?: unknown }): KernelSession {
    if (!session.planState) throw new Error("Plan Mode is not active");
    if (input.decision === "continue") {
      const document = session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction.document : "";
      const resolved = resolvePlanApproval(approvePlan(session.planState, document, input.feedback), "continue");
      return reduceKernelSession({ ...session, planState: resolved.state, toolPermissionContext: resolved.permissions }, { type: "pending_interaction_cleared", status: "idle_input" });
    }
    const resolved = resolvePlanApproval(session.planState, "stay", input.feedback);
    return reduceKernelSession({ ...session, planState: resolved.state, toolPermissionContext: resolved.permissions }, { type: "pending_interaction_cleared", status: "planning" });
  }

  buildApprovedPlanHandoff(session: KernelSession): ApprovedPlanHandoff {
    if (!session.planState) throw new Error("Plan Mode is not active");
    const planText = session.planState.approvedPlan ?? "";
    return { sessionId: session.id, approvalId: session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction.id : `${session.id}:approved`, planFilePath: session.planState.planFilePath, planText, planHash: hashText(planText), originalInput: session.planState.originalInput, legacyHandoff: buildLegacyHandoff(session.planState) };
  }

  async recoverPlanDocument(session: KernelSession): Promise<string | undefined> {
    if (!session.planState) return undefined;
    return readPlan(session.planState.planFilePath);
  }
}

function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
```

- [ ] **Step 4: Verify**

Run: `npm run build:test && node dist-test/tests/kernel/planModeController.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/kernel/plan/planModeController.ts tests/kernel/planModeController.test.ts && git commit -m "task-none:新增Plan模式控制器"`

---

### Task 5: Query Engine and Runtime Delegation

**Files:**
- Create: `src/kernel/queryEngine.ts`
- Modify: `src/runtime/turnExecutor.ts`
- Test: `tests/kernel/queryEngine.test.ts`
- Test: `tests/runtime/turnExecutor.test.ts`

- [ ] **Step 1: Write the failing QueryEngine test**

Create `tests/kernel/queryEngine.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession } from "../../src/kernel/session.js";
import { QueryEngine } from "../../src/kernel/queryEngine.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ModelProvider } from "../../src/providers/types.js";

function providerWithToolCalls(tool_calls: { id: string; name: string; input: unknown }[]): ModelProvider {
  return { generate: async () => ({ content: "", tool_calls }), stream: undefined } as unknown as ModelProvider;
}

describe("QueryEngine", () => {
  it("turns user interaction tools into pending interactions", async () => {
    const legacy = new ToolRegistry();
    legacy.add({ name: "AskUserQuestion", description: "ask", input_schema: {}, requiresUserInteraction: async () => true, execute: async () => ({ data: { type: "user_input_requested", questions: [{ question: "Pick?" }] } }) });
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions: { mode: "plan", allow: [], ask: [], deny: [] } });

    const result = await new QueryEngine().run({ session, provider: providerWithToolCalls([{ id: "call-1", name: "AskUserQuestion", input: { questions: [{ question: "Pick?" }] } }]), model: "test-model", tools: createKernelToolRegistry(legacy) });

    assert.equal(result.session.status, "waiting_user_input");
    assert.equal(result.session.pendingInteraction?.type, "ask_user_question");
  });
});
```

- [ ] **Step 2: Run it and verify failure**

Run: `npm run build:test && node dist-test/tests/kernel/queryEngine.test.js`
Expected: compile fails because `QueryEngine` does not exist.

- [ ] **Step 3: Implement `src/kernel/queryEngine.ts`**

```ts
import type { ModelProvider, ModelToolCall } from "../providers/types.js";
import { PermissionKernel } from "./permissions/permissionKernel.js";
import type { KernelSession } from "./session.js";
import { reduceKernelSession } from "./session.js";
import type { KernelToolRegistry } from "./tools/registry.js";

const maxToolIterations = 20;

export type QueryEngineInput = { session: KernelSession; provider: ModelProvider; model: string; tools: KernelToolRegistry };
export type QueryEngineResult = { session: KernelSession };

export class QueryEngine {
  private readonly permissions = new PermissionKernel();

  async run(input: QueryEngineInput): Promise<QueryEngineResult> {
    let session = reduceKernelSession(input.session, { type: "status_set", status: input.session.toolPermissionContext.mode === "plan" ? "planning" : "running_query" });
    const messages = session.messages.slice();
    for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
      const response = await input.provider.generate({ model: input.model, messages, tools: input.tools.visibleTools(session.toolPermissionContext).map((tool) => tool.legacyTool), context: { runId: session.workflowBinding?.runId ?? session.id, nodeId: "kernel", attempt: iteration + 1, sessionId: session.id, threadId: session.id, turnId: `${session.id}:${iteration + 1}`, promptCacheKey: session.id } });
      if (!response.tool_calls?.length) return { session: { ...session, messages: response.content === undefined ? messages : [...messages, { role: "assistant", content: response.content }], status: "idle_input" } };
      const calls = await callsUntilUserInteraction(response.tool_calls, input.tools, session);
      messages.push({ role: "assistant", content: response.content ?? "", tool_calls: calls });
      for (const call of calls) {
        const tool = input.tools.get(call.name);
        const permission = await this.permissions.check(tool, call.input, { ...session.toolPermissionContext, cwd: session.cwd });
        if (permission.decision === "ask") return { session: reduceKernelSession({ ...session, messages }, { type: "pending_interaction_set", interaction: { type: "tool_permission", id: call.id, sessionId: session.id, tool: call.name, input: call.input, reason: permission.reason, rule: permission.rule } }) };
        if (permission.decision === "deny") return { session: { ...session, messages: [...messages, { role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: permission.reason ?? "Permission denied" }) }], status: "idle_input" } };
      }
      for (const call of calls) {
        const tool = input.tools.get(call.name);
        const context = { cwd: session.cwd, sessionId: session.id, planState: session.planState ?? undefined };
        const interaction = await tool.requiresUserInteraction(call.input, context);
        const result = await tool.execute(call.input, context);
        if (interaction?.type === "ask_user_question") return { session: reduceKernelSession({ ...session, messages }, { type: "pending_interaction_set", interaction: { type: "ask_user_question", id: call.id, sessionId: session.id, toolCallId: call.id, questions: interaction.questions ?? questionsFromResult(result) } }) };
        if (interaction?.type === "plan_approval") return { session: reduceKernelSession({ ...session, messages }, { type: "pending_interaction_set", interaction: planApprovalFromResult(call.id, session.id, result, session.planState?.planFilePath ?? "") }) };
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(tool.mapToolResultToModelResult(result, context)) });
      }
    }
    return { session: { ...session, messages, status: "idle_input" } };
  }
}

async function callsUntilUserInteraction(calls: ModelToolCall[], tools: KernelToolRegistry, session: KernelSession): Promise<ModelToolCall[]> {
  for (let index = 0; index < calls.length; index += 1) {
    if (await tools.get(calls[index].name).requiresUserInteraction(calls[index].input, { cwd: session.cwd, sessionId: session.id, planState: session.planState ?? undefined })) return calls.slice(0, index + 1);
  }
  return calls;
}

function questionsFromResult(result: { data?: unknown }): unknown[] {
  const data = result.data as { questions?: unknown } | undefined;
  return Array.isArray(data?.questions) ? data.questions : [];
}

function planApprovalFromResult(id: string, sessionId: string, result: { data?: unknown }, fallbackPath: string) {
  const data = result.data as { plan?: { document?: string; planFilePath?: string; empty?: boolean } } | undefined;
  return { type: "plan_approval" as const, id, sessionId, document: data?.plan?.document ?? "", planFilePath: data?.plan?.planFilePath ?? fallbackPath, empty: data?.plan?.empty };
}
```

- [ ] **Step 4: Delegate runtime visibility and permission**

In `src/runtime/turnExecutor.ts`, replace the local Plan Mode visible set with Kernel registry:

```ts
import { PermissionKernel } from "../kernel/permissions/permissionKernel.js";
import { createKernelToolRegistry } from "../kernel/tools/registry.js";

function modelVisibleTools(input: RuntimeTurnInput): Tool[] {
  return createKernelToolRegistry(input.tools).visibleTools(input.permissions).map((tool) => tool.legacyTool);
}
```

Build `const permissionKernel = new PermissionKernel();` inside `execute` and use it instead of direct `checkToolPermission`:

```ts
const kernelTools = createKernelToolRegistry(input.tools);
const permission = await permissionKernel.check(kernelTools.get(call.name), call.input, { ...input.permissions, cwd: input.cwd });
```

- [ ] **Step 5: Verify**

Run: `npm run build:test && node dist-test/tests/kernel/queryEngine.test.js && node dist-test/tests/runtime/turnExecutor.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add src/kernel/queryEngine.ts src/runtime/turnExecutor.ts tests/kernel/queryEngine.test.ts tests/runtime/turnExecutor.test.ts && git commit -m "task-none:抽出QueryEngine工具循环"`


---

### Task 6: Workflow Backend

**Files:**
- Create: `src/kernel/workflow/workflowBackend.ts`
- Modify: `src/workflow/engine.ts`
- Test: `tests/workflow/kernelBackend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/workflow/kernelBackend.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowBackend } from "../../src/kernel/workflow/workflowBackend.js";
import type { ApprovedPlanHandoff } from "../../src/kernel/plan/planModeController.js";

describe("WorkflowBackend", () => {
  it("starts once per approval id and plan hash", async () => {
    const starts: unknown[] = [];
    const backend = new WorkflowBackend({ startWorkflow: async (handoff) => { starts.push(handoff); return { runId: "run-1", status: "running" as const }; } });
    const handoff: ApprovedPlanHandoff = { sessionId: "s1", approvalId: "approval-1", planFilePath: ".session/plans/s1.md", planText: "# Plan", planHash: "a".repeat(64), originalInput: { request: "build" }, legacyHandoff: { original_input: { request: "build" }, approved_plan: "# Plan" } };

    assert.equal((await backend.startOrResume(handoff)).runId, "run-1");
    assert.equal((await backend.startOrResume(handoff)).runId, "run-1");
    assert.equal(starts.length, 1);
  });
});
```

- [ ] **Step 2: Implement `src/kernel/workflow/workflowBackend.ts`**

```ts
import type { ApprovedPlanHandoff } from "../plan/planModeController.js";

export type WorkflowBackendRun = { runId: string; status: "pending" | "running" | "waiting" | "completed" };
export type WorkflowBackendOptions = { startWorkflow: (handoff: unknown) => Promise<WorkflowBackendRun> };

export class WorkflowBackend {
  private readonly runs = new Map<string, WorkflowBackendRun>();
  constructor(private readonly options: WorkflowBackendOptions) {}

  async startOrResume(handoff: ApprovedPlanHandoff): Promise<WorkflowBackendRun> {
    const key = `${handoff.sessionId}:${handoff.approvalId}:${handoff.planHash}`;
    const existing = this.runs.get(key);
    if (existing) return existing;
    const run = await this.options.startWorkflow(handoff.legacyHandoff);
    this.runs.set(key, run);
    return run;
  }
}
```

- [ ] **Step 3: Add workflow engine adapter**

In `src/workflow/engine.ts`, add a factory near the public exports:

```ts
import { WorkflowBackend } from "../kernel/workflow/workflowBackend.js";

export function createWorkflowBackend(engine: WorkflowEngine): WorkflowBackend {
  return new WorkflowBackend({
    startWorkflow: async (handoff) => {
      const session = await engine.startInteractive(handoff);
      return { runId: session.runId, status: session.state.status === "completed" ? "completed" : "running" };
    }
  });
}
```

If the current `startInteractive` signature differs, wire this factory to the existing public start method without changing workflow config semantics.

- [ ] **Step 4: Verify**

Run: `npm run build:test && node dist-test/tests/workflow/kernelBackend.test.js && node dist-test/tests/workflow/planModeSeparation.test.js`
Expected: PASS. `planModeSeparation` must continue proving workflow config cannot configure Plan Mode.

- [ ] **Step 5: Commit**

Run: `git add src/kernel/workflow/workflowBackend.ts src/workflow/engine.ts tests/workflow/kernelBackend.test.ts && git commit -m "task-none:新增workflow内核后端"`

---

### Task 7: SDK and Headless Kernel Session

**Files:**
- Modify: `src/sdk/localSession.ts`
- Modify: `src/sdk/headless.ts`
- Test: `tests/sdk/kernelSession.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sdk/kernelSession.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalHeadlessSession } from "../../src/sdk/localSession.js";
import type { ModelProvider } from "../../src/providers/types.js";

function emptyProvider(): ModelProvider { return { generate: async () => ({ content: "done" }), stream: undefined } as unknown as ModelProvider; }

describe("SDK KernelSession integration", () => {
  it("exposes kernel app state", () => {
    const session = new LocalHeadlessSession({ sessionId: "sdk-s1", cwd: process.cwd(), provider: emptyProvider(), model: "test-model" });
    session.enterPlanMode({ request: "build" });
    const state = session.getAppState();

    assert.equal(state.status, "planning");
    assert.equal(state.planState?.mode, "planning");
  });
});
```

- [ ] **Step 2: Modify `src/sdk/localSession.ts`**

Add Kernel imports:

```ts
import { createKernelSession, projectAppState, type KernelSession } from "../kernel/session.js";
import { PlanModeController } from "../kernel/plan/planModeController.js";
```

Add fields:

```ts
private kernelSession: KernelSession;
private readonly planController = new PlanModeController();
```

Initialize in constructor:

```ts
this.kernelSession = createKernelSession({ id: this.sessionId, cwd: options.cwd, permissions: this.permissions });
```

Add method:

```ts
getAppState() {
  return projectAppState(this.kernelSession);
}
```

Update `enterPlanMode`:

```ts
enterPlanMode(originalInput: unknown): RuntimeEvent {
  this.kernelSession = this.planController.enterPlanMode(this.kernelSession, originalInput);
  this.planState = this.kernelSession.planState ?? undefined;
  this.permissions = this.kernelSession.toolPermissionContext;
  return { type: "plan_mode_entered", session_id: this.sessionId, plan_file_path: this.kernelSession.planState!.planFilePath };
}
```

Keep existing `query`, `updatePlanDraft`, and `requestPlanApproval` compatible. After those paths mutate messages, permissions, or plan state, mirror the value back into `this.kernelSession`.

- [ ] **Step 3: Verify**

Run: `npm run build:test && node dist-test/tests/sdk/kernelSession.test.js && node dist-test/tests/sdk/localSession.test.js && node dist-test/tests/sdk/headless.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

Run: `git add src/sdk/localSession.ts src/sdk/headless.ts tests/sdk/kernelSession.test.ts && git commit -m "task-none:SDK接入KernelSession"`

---

### Task 8: TUI Kernel Adapter

**Files:**
- Create: `src/tui/kernelAdapter.ts`
- Modify: `src/tui/TuiApp.tsx`
- Modify: `src/tui/components/PlanReviewPrompt.tsx`
- Test: `tests/tui/kernelIntegration.test.tsx`

- [ ] **Step 1: Write the failing adapter test**

Create `tests/tui/kernelIntegration.test.tsx`:

```tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession, reduceKernelSession } from "../../src/kernel/session.js";
import { createTuiKernelAdapter } from "../../src/tui/kernelAdapter.js";

describe("TUI kernel adapter", () => {
  it("projects plan approval pending interaction", () => {
    const session = reduceKernelSession(createKernelSession({ id: "s1", cwd: process.cwd(), permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" } }), {
      type: "pending_interaction_set",
      interaction: { type: "plan_approval", id: "approval-1", sessionId: "s1", document: "# Plan", planFilePath: ".session/plans/s1.md" }
    });

    const adapter = createTuiKernelAdapter(session);
    assert.equal(adapter.appState.status, "waiting_plan_approval");
    assert.equal(adapter.planReview?.document, "# Plan");
  });
});
```

- [ ] **Step 2: Implement `src/tui/kernelAdapter.ts`**

```ts
import type { KernelSession, PendingInteraction } from "../kernel/session.js";
import { projectAppState } from "../kernel/session.js";

type PlanApproval = Extract<PendingInteraction, { type: "plan_approval" }>;

export function createTuiKernelAdapter(session: KernelSession): { appState: ReturnType<typeof projectAppState>; planReview: PlanApproval | null } {
  return { appState: projectAppState(session), planReview: session.pendingInteraction?.type === "plan_approval" ? session.pendingInteraction : null };
}
```

- [ ] **Step 3: Refactor TUI to consume adapter state**

In `src/tui/TuiApp.tsx`, introduce Kernel adapter state near existing Plan Mode derived state:

```tsx
const kernelAdapter = kernelSession ? createTuiKernelAdapter(kernelSession) : undefined;
const pendingPlanReview = kernelAdapter?.planReview ?? legacyPendingPlanReview;
```

Route approve/reject through Kernel when present:

```ts
function resolvePendingPlanReview(decision: "continue" | "stay", feedback?: unknown): void {
  if (kernelSession && kernelAdapter?.planReview) {
    setKernelSession(planController.resolvePlanApproval(kernelSession, { decision, feedback }));
    return;
  }
  legacyResolvePlanReview(decision, feedback);
}
```

This task may keep legacy fallback. Acceptance requires Kernel pending interaction to render, and existing TUI tests must still pass.

- [ ] **Step 4: Verify**

Run: `npm run build:test && node dist-test/tests/tui/kernelIntegration.test.js && node dist-test/tests/tui/tuiAppPlanMode.test.js && node dist-test/tests/tui/tuiAppPlanReviewTranscript.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add src/tui/kernelAdapter.ts src/tui/TuiApp.tsx src/tui/components/PlanReviewPrompt.tsx tests/tui/kernelIntegration.test.tsx && git commit -m "task-none:TUI接入Kernel pending interaction"`

---

### Task 9: Final Verification and Documentation Sync

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-tool-protocol-plan-mode-kernel-design.md`
- Modify: `docs/2026-06-27-tui-code-replication.md`
- Modify: `docs/tui-code-replication-scope.md`

- [ ] **Step 1: Add implemented module map to the spec**

Append this section to the design spec:

```md
## Implemented Module Map

- `src/kernel/session.ts`
- `src/kernel/tools/protocol.ts`
- `src/kernel/tools/registry.ts`
- `src/kernel/permissions/permissionKernel.ts`
- `src/kernel/plan/planModeController.ts`
- `src/kernel/queryEngine.ts`
- `src/kernel/workflow/workflowBackend.ts`
- `src/tui/kernelAdapter.ts`
```

- [ ] **Step 2: Update replication docs**

Add this section to both replication docs:

```md
## Kernel Plan Mode Alignment

Plan Mode is represented as Kernel session state instead of TUI-local refs. The model sees write tools in Plan Mode, while `PermissionKernel` restricts writes to the active plan file. `ExitPlanMode` produces a Kernel pending interaction for plan approval, and approved plans are handed to workflow through `WorkflowBackend`.
```

- [ ] **Step 3: Run focused acceptance**

Run:

```bash
npm run build:test
node dist-test/tests/kernel/session.test.js
node dist-test/tests/kernel/toolProtocol.test.js
node dist-test/tests/kernel/permissionKernel.test.js
node dist-test/tests/kernel/planModeController.test.js
node dist-test/tests/kernel/queryEngine.test.js
node dist-test/tests/workflow/kernelBackend.test.js
node dist-test/tests/sdk/kernelSession.test.js
node dist-test/tests/tui/kernelIntegration.test.js
node dist-test/tests/plans/planMode.test.js
node dist-test/tests/runtime/turnExecutor.test.js
node dist-test/tests/tui/tuiAppPlanMode.test.js
node dist-test/tests/workflow/planModeSeparation.test.js
git diff --check
```

Expected: every command exits with code 0.

- [ ] **Step 4: Run full project verification**

Run: `npm test`
Expected: build and all registered tests pass.

- [ ] **Step 5: Inspect git status**

Run: `git status --short`
Expected: only files touched by this plan are staged or modified. Existing unrelated files such as `agent-team.yaml` must not be staged.

- [ ] **Step 6: Commit**

Run: `git add docs/superpowers/specs/2026-06-30-tool-protocol-plan-mode-kernel-design.md docs/2026-06-27-tui-code-replication.md docs/tui-code-replication-scope.md && git commit -m "task-none:同步Plan模式内核对齐文档"`

---

## Execution Notes

- 当前环境可能限制 `.git/index` 写入。如果 `git add` 因权限失败，保留工作区改动并在最终报告中说明 commit 被环境阻断。
- 任何删除文件的操作必须先获得用户明确同意。
- Plan Mode 下暴露 `Write`、`Edit`、`MultiEdit` 是架构要求；安全边界在 `PermissionKernel`，不是靠隐藏工具。
- 每个任务完成后先跑该任务列出的 focused tests，再进入下一任务。
- 如果旧测试暴露现有行为依赖 TUI-local Plan Mode 状态，优先把该测试改成断言 Kernel projected state，而不是在 TUI 里新增第二套状态。

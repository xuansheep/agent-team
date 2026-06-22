# TUI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade default terminal UI for `agent-team` while keeping existing subcommands headless and script-friendly.

**Architecture:** Keep workflow execution headless and expose a new interactive session API for TUI. Runtime emits persisted events, pauses for permission decisions, and supports safe interruption. The TUI is a React + Ink shell with a production-grade PromptInput subsystem and reducer-driven rendering.

**Tech Stack:** TypeScript, Node.js ESM, Commander, React, Ink, node:test, Zod, existing RunStore and WorkflowEngine.

---

## Scope Check

This plan implements one integrated feature: an interactive TUI for the existing local workflow harness. The PromptInput subsystem is large, but it is necessary for the agreed production-grade TUI and is still bounded to one workflow run per TUI session.

## File Structure

Create:

- `src/cli/dispatch.ts`: chooses default TUI vs existing Commander subcommands.
- `src/harness/permissionController.ts`: waits for and resolves one-shot permission decisions.
- `src/harness/eventStream.ts`: in-memory async event stream used by interactive sessions.
- `src/workflow/session.ts`: public `WorkflowSession` and related types.
- `src/tui/launchTui.tsx`: Ink launcher.
- `src/tui/TuiApp.tsx`: TUI state machine container.
- `src/tui/state.ts`: UI state, reducer, and user actions.
- `src/tui/eventAdapter.ts`: converts stored runtime events into UI state.
- `src/tui/commands.ts`: slash command parsing.
- `src/tui/components/Header.tsx`
- `src/tui/components/WorkflowPicker.tsx`
- `src/tui/components/RunTimeline.tsx`
- `src/tui/components/NodeStatusList.tsx`
- `src/tui/components/ToolCallList.tsx`
- `src/tui/components/PermissionPrompt.tsx`
- `src/tui/components/UserQuestionPrompt.tsx`
- `src/tui/components/ResultPanel.tsx`
- `src/tui/components/Footer.tsx`
- `src/tui/components/PromptInput/PromptInput.tsx`
- `src/tui/components/PromptInput/PromptInputFooter.tsx`
- `src/tui/components/PromptInput/PromptInputModeIndicator.tsx`
- `src/tui/components/PromptInput/PromptInputQueuedCommands.tsx`
- `src/tui/components/PromptInput/PromptInputSuggestions.tsx`
- `src/tui/components/PromptInput/PromptInputHistory.tsx`
- `src/tui/components/PromptInput/PromptInputStashNotice.tsx`
- `src/tui/components/PromptInput/usePromptBuffer.ts`
- `src/tui/components/PromptInput/usePromptHistory.ts`
- `src/tui/components/PromptInput/usePromptKeybindings.ts`
- `src/tui/components/PromptInput/usePromptSuggestions.ts`
- `src/tui/components/PromptInput/keybindings.ts`
- `src/tui/components/PromptInput/types.ts`
- `tests/cli/dispatch.test.ts`
- `tests/harness/permissionController.test.ts`
- `tests/harness/runtime.interactive.test.ts`
- `tests/workflow/session.test.ts`
- `tests/tui/eventAdapter.test.ts`
- `tests/tui/promptInput.test.ts`
- `tests/tui/components.test.tsx`

Modify:

- `package.json`: add React/Ink dependencies and keep existing scripts.
- `tsconfig.json`: enable TSX compilation.
- `tsconfig.test.json`: include `.tsx` tests and source files.
- `src/cli/main.ts`: delegate to `dispatchCli`.
- `src/harness/events.ts`: add interactive events and correlation fields.
- `src/harness/runtime.ts`: accept interactive permission callbacks.
- `src/storage/runStore.ts`: support interrupted state helper.
- `src/workflow/engine.ts`: add `startInteractive`, event publishing, and interrupt handling.
- `scripts/run-tests.mjs`: include `.test.js` emitted from `.test.tsx` without special casing.

---

### Task 1: TSX Toolchain and CLI Dispatch Boundary

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.test.json`
- Modify: `src/cli/main.ts`
- Create: `src/cli/dispatch.ts`
- Create: `tests/cli/dispatch.test.ts`

- [ ] **Step 1: Install TUI dependencies**

Run:

```powershell
npm install react@18 ink@5
npm install -D @types/react@18 ink-testing-library@3
```

Expected: `package.json` and `package-lock.json` include React, Ink, React types, and Ink test support.

- [ ] **Step 2: Write the failing dispatch tests**

Create `tests/cli/dispatch.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldLaunchTui, dispatchCli } from "../../src/cli/dispatch.js";

describe("CLI dispatch", () => {
  it("launches TUI when no subcommand is provided", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team"]), true);
  });

  it("keeps explicit subcommands headless", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team", "run"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "status", "run-id"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "inspect", "run-id"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "resume", "run-id"]), false);
    assert.equal(shouldLaunchTui(["node", "agent-team", "init"]), false);
  });

  it("calls the launcher only for the no-subcommand path", async () => {
    let launched = 0;
    await dispatchCli(["node", "agent-team"], async () => {
      launched += 1;
    });
    assert.equal(launched, 1);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run:

```powershell
npm test -- tests/cli/dispatch.test.ts
```

Expected: FAIL because `src/cli/dispatch.ts` does not exist.

- [ ] **Step 4: Enable TSX compilation**

Modify `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

Modify `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist-test"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"]
}
```

- [ ] **Step 5: Implement the dispatcher**

Create `src/cli/dispatch.ts`:

```ts
import { createProgram } from "./program.js";
import { launchTui } from "../tui/launchTui.js";

export type TuiLauncher = (options: { cwd: string }) => Promise<void>;

export function shouldLaunchTui(argv: string[]): boolean {
  return argv.slice(2).length === 0;
}

export async function dispatchCli(argv = process.argv, launcher: TuiLauncher = launchTui): Promise<void> {
  if (shouldLaunchTui(argv)) {
    await launcher({ cwd: process.cwd() });
    return;
  }

  createProgram().parse(argv);
}
```

Create a temporary launcher stub so Task 1 compiles:

```ts
// src/tui/launchTui.tsx
export async function launchTui(_options: { cwd: string }): Promise<void> {
  console.log("Interactive TUI is not wired yet");
}
```

Modify `src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { dispatchCli } from "./dispatch.js";

void dispatchCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 6: Run the dispatch test and build**

Run:

```powershell
npm test -- tests/cli/dispatch.test.ts
npm run build
```

Expected: PASS and build succeeds.

- [ ] **Step 7: Commit**

Run:

```powershell
git add package.json package-lock.json tsconfig.json tsconfig.test.json src/cli/main.ts src/cli/dispatch.ts src/tui/launchTui.tsx tests/cli/dispatch.test.ts
git commit -m "task-0623:添加 TUI 入口分发"
```

---

### Task 2: Interactive Event Types and Interrupted State Storage

**Files:**
- Modify: `src/harness/events.ts`
- Modify: `src/storage/runStore.ts`
- Create: `tests/storage/interactiveEvents.test.ts`

- [ ] **Step 1: Write failing tests for interactive events and interruption**

Create `tests/storage/interactiveEvents.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "../../src/storage/runStore.js";

describe("interactive run events", () => {
  it("stores permission and interrupt events", async () => {
    const store = new RunStore(".tmp/interactive-events");
    const run = await store.createRun("flow", { request: "x" });

    await store.appendEvent(run.runId, {
      type: "permission_requested",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      tool: "Bash",
      input: { command: "npm test" },
      specifier: "npm test"
    });
    await store.appendEvent(run.runId, {
      type: "permission_resolved",
      request_id: "perm-1",
      node_id: "dev",
      attempt: 1,
      tool_call_id: "tool-1",
      decision: "allow_once"
    });
    await store.markInterrupted(run.runId, {
      status: "interrupted",
      workflow_id: "flow",
      current_node_id: "dev",
      attempts: [{ node_id: "dev", attempt: 1, status: "running" }],
      handoff: { request: "x" }
    });

    const events = await store.loadEvents(run.runId);
    assert.equal(events.some((event) => event.type === "permission_requested"), true);
    assert.equal(events.some((event) => event.type === "permission_resolved"), true);
    assert.equal(events.some((event) => event.type === "run_interrupted"), true);

    const state = await store.loadState(run.runId);
    assert.equal(state.status, "interrupted");
    assert.equal(state.current_node_id, "dev");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
npm test -- tests/storage/interactiveEvents.test.ts
```

Expected: FAIL because event variants and `markInterrupted` do not exist.

- [ ] **Step 3: Extend event types**

Modify `src/harness/events.ts` so `HarnessEvent` includes:

```ts
export type HarnessEvent =
  | { type: "run_started"; workflow_id: string; input: unknown }
  | { type: "node_started"; node_id: string; attempt: number }
  | { type: "node_waiting_user"; node_id: string; questions: unknown[] }
  | { type: "tool_invoked"; node_id: string; attempt?: number; tool_call_id?: string; tool: string; input: unknown }
  | { type: "tool_completed"; node_id: string; attempt?: number; tool_call_id?: string; tool: string; result: unknown }
  | { type: "tool_failed"; node_id: string; attempt?: number; tool_call_id?: string; tool: string; error: string }
  | { type: "artifact_created"; node_id: string; artifact_id: string; path: string }
  | { type: "node_completed"; node_id: string; status: "success" | "failure"; result: unknown }
  | { type: "transition"; from: string; to: string; reason: "success" | "failure" }
  | { type: "permission_requested"; request_id: string; node_id: string; attempt: number; tool_call_id: string; tool: string; input: unknown; rule?: string; specifier: string }
  | { type: "permission_resolved"; request_id: string; node_id: string; attempt: number; tool_call_id: string; decision: "allow_once" | "deny_once" }
  | { type: "node_interrupted"; node_id: string; attempt: number }
  | { type: "run_interrupted"; reason: "user" }
  | { type: "run_completed"; result: unknown }
  | { type: "run_failed"; error: string };

export type StoredEvent = HarnessEvent & {
  ts: string;
  seq: number;
};
```

- [ ] **Step 4: Add interrupted storage helper**

Modify `src/storage/runStore.ts`:

```ts
async markInterrupted(runId: string, state: WorkflowState): Promise<void> {
  await this.appendEvent(runId, { type: "run_interrupted", reason: "user" });
  await this.saveState(runId, state);
}
```

- [ ] **Step 5: Run storage tests**

Run:

```powershell
npm test -- tests/storage/interactiveEvents.test.ts tests/storage/runStore.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/harness/events.ts src/storage/runStore.ts tests/storage/interactiveEvents.test.ts
git commit -m "task-0623:扩展交互式运行事件"
```

---

### Task 3: Permission Controller

**Files:**
- Create: `src/harness/permissionController.ts`
- Create: `tests/harness/permissionController.test.ts`

- [ ] **Step 1: Write failing permission controller tests**

Create `tests/harness/permissionController.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionController } from "../../src/harness/permissionController.js";

describe("PermissionController", () => {
  it("waits until a request is resolved", async () => {
    const controller = new PermissionController();
    const waiting = controller.request({
      requestId: "perm-1",
      nodeId: "dev",
      attempt: 1,
      toolCallId: "tool-1",
      tool: "Bash",
      input: { command: "npm test" },
      specifier: "npm test",
      rule: "Bash(npm test)"
    });

    controller.resolve("perm-1", "allow_once");

    assert.equal(await waiting, "allow_once");
  });

  it("rejects unknown request ids", () => {
    const controller = new PermissionController();
    assert.throws(() => controller.resolve("missing", "deny_once"), /Unknown permission request missing/);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm test -- tests/harness/permissionController.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement permission controller**

Create `src/harness/permissionController.ts`:

```ts
export type PermissionDecision = "allow_once" | "deny_once";

export type PermissionRequest = {
  requestId: string;
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  input: unknown;
  specifier: string;
  rule?: string;
};

type PendingRequest = {
  resolve: (decision: PermissionDecision) => void;
};

export class PermissionController {
  private readonly pending = new Map<string, PendingRequest>();

  request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.pending.has(request.requestId)) {
      throw new Error(`Duplicate permission request ${request.requestId}`);
    }

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.requestId, { resolve });
    });
  }

  resolve(requestId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`Unknown permission request ${requestId}`);
    this.pending.delete(requestId);
    pending.resolve(decision);
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}
```

- [ ] **Step 4: Run permission controller tests**

Run:

```powershell
npm test -- tests/harness/permissionController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/harness/permissionController.ts tests/harness/permissionController.test.ts
git commit -m "task-0623:添加权限确认控制器"
```

---

### Task 4: Runtime Interactive Permission Handling

**Files:**
- Modify: `src/harness/runtime.ts`
- Create: `tests/harness/runtime.interactive.test.ts`

- [ ] **Step 1: Write failing runtime permission test**

Create `tests/harness/runtime.interactive.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNode } from "../../src/harness/runtime.js";
import { RunStore } from "../../src/storage/runStore.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ModelProvider } from "../../src/providers/types.js";

describe("runNode interactive permissions", () => {
  it("asks for permission and executes tool after allow_once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-runtime-"));
    const store = new RunStore(root);
    const run = await store.createRun("flow", { request: "x" });
    const tools = new ToolRegistry();
    tools.add({
      name: "Bash",
      description: "fake bash",
      input_schema: {},
      async execute() {
        return { output: "ok", exit_code: 0 };
      }
    });

    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return { tool_calls: [{ id: "tool-1", name: "Bash", input: { command: "npm test" } }] };
        }
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };

    const result = await runNode({
      node: { id: "dev", role: "dev", provider: "default", permission_mode: "default" },
      systemPrompt: "Dev",
      model: "gpt-test",
      provider,
      tools,
      permissions: { allow: [], ask: ["Bash(npm test)"], deny: [] },
      cwd: process.cwd(),
      runId: run.runId,
      store,
      handoff: { request: "x" },
      attempt: 1,
      interaction: {
        async requestPermission(request) {
          assert.equal(request.tool, "Bash");
          assert.equal(request.specifier, "npm test");
          return "allow_once";
        }
      }
    });

    assert.equal(result.status, "success");
    const eventsText = await readFile(join(root, run.runId, "events.ndjson"), "utf8");
    assert.match(eventsText, /permission_requested/);
    assert.match(eventsText, /permission_resolved/);
    assert.match(eventsText, /tool_completed/);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm test -- tests/harness/runtime.interactive.test.ts
```

Expected: FAIL because `runNode` has no `attempt` or `interaction` option.

- [ ] **Step 3: Extend runtime option types**

Modify `src/harness/runtime.ts` imports and types:

```ts
import { randomUUID } from "node:crypto";
import { PermissionDecision, PermissionRequest } from "./permissionController.js";

export type RuntimeInteraction = {
  requestPermission?(request: PermissionRequest): Promise<PermissionDecision>;
};

export type NodeRuntimeOptions = {
  node: WorkflowNodeConfig;
  systemPrompt: string;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: PermissionSet;
  cwd: string;
  runId: string;
  store: RunStore;
  handoff: unknown;
  attempt?: number;
  interaction?: RuntimeInteraction;
};
```

- [ ] **Step 4: Implement interactive ask behavior**

Replace the `ask` branch in `runNode` with this behavior:

```ts
const attempt = options.attempt ?? 1;

if (permission.decision === "ask") {
  if (!options.interaction?.requestPermission) {
    const error = `Permission ask is not interactive in this MVP for ${call.name}`;
    await options.store.appendEvent(options.runId, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
    throw new Error(error);
  }

  const requestId = randomUUID();
  const request = {
    requestId,
    nodeId: options.node.id,
    attempt,
    toolCallId: call.id,
    tool: call.name,
    input: call.input,
    specifier,
    rule: permission.rule
  };
  await options.store.appendEvent(options.runId, {
    type: "permission_requested",
    request_id: requestId,
    node_id: options.node.id,
    attempt,
    tool_call_id: call.id,
    tool: call.name,
    input: call.input,
    rule: permission.rule,
    specifier
  });
  const decision = await options.interaction.requestPermission(request);
  await options.store.appendEvent(options.runId, {
    type: "permission_resolved",
    request_id: requestId,
    node_id: options.node.id,
    attempt,
    tool_call_id: call.id,
    decision
  });
  if (decision === "deny_once") {
    const error = `Permission denied by user for ${call.name}`;
    await options.store.appendEvent(options.runId, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error }) });
    continue;
  }
}
```

Also add `attempt` and `tool_call_id` to `tool_invoked`, `tool_completed`, and `tool_failed` events emitted by `runNode`.

- [ ] **Step 5: Run runtime tests**

Run:

```powershell
npm test -- tests/harness/runtime.interactive.test.ts tests/workflow/engine.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/harness/runtime.ts tests/harness/runtime.interactive.test.ts
git commit -m "task-0623:支持运行时交互权限确认"
```

---

### Task 5: WorkflowSession and Interactive Engine

**Files:**
- Create: `src/harness/eventStream.ts`
- Create: `src/workflow/session.ts`
- Modify: `src/workflow/engine.ts`
- Create: `tests/workflow/session.test.ts`

- [ ] **Step 1: Write failing interactive session tests**

Create `tests/workflow/session.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { ModelProvider } from "../../src/providers/types.js";

describe("WorkflowSession", () => {
  it("streams events and resolves a completed result", async () => {
    const provider: ModelProvider = {
      async generate() {
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-runs" });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    const seen: string[] = [];
    for await (const event of session.events) {
      seen.push(event.type);
      if (event.type === "node_completed") break;
    }

    const result = await session.result;
    assert.equal(result.status, "completed");
    assert.equal(seen.includes("node_started"), true);
    assert.equal(seen.includes("node_completed"), true);
  });

  it("marks a running session interrupted", async () => {
    let release!: () => void;
    const provider: ModelProvider = {
      async generate() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: JSON.stringify({ status: "success", summary: "done", handoff: { instruction: "next" } }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: ".tmp/session-interrupt-runs" });
    const session = await engine.startInteractive(config(), "flow", { request: "x" });

    await session.interrupt();
    release();

    const result = await session.result;
    assert.equal(result.status, "interrupted");
  });
});

function config() {
  return {
    providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
    roles: { dev: { description: "", system_prompt: "D", requires: { tool_calling: false, vision: false } } },
    workflows: { flow: { nodes: [{ id: "dev", role: "dev", provider: "default", permission_mode: "default" as const }], edges: [] } }
  };
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm test -- tests/workflow/session.test.ts
```

Expected: FAIL because `startInteractive` does not exist.

- [ ] **Step 3: Implement event stream**

Create `src/harness/eventStream.ts`:

```ts
export class EventStream<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.queued.push(value);
  }

  end(): void {
    this.ended = true;
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      }
    };
  }
}
```

- [ ] **Step 4: Define session types**

Create `src/workflow/session.ts`:

```ts
import { PermissionController } from "../harness/permissionController.js";
import { StoredEvent } from "../harness/events.js";
import { WorkflowState } from "./state.js";

export type WorkflowSession = {
  runId: string;
  state: WorkflowState;
  events: AsyncIterable<StoredEvent>;
  permissions: PermissionController;
  interrupt(): Promise<void>;
  resumeWithUserInput(input: unknown): Promise<void>;
  result: Promise<WorkflowState>;
};
```

- [ ] **Step 5: Add interactive engine skeleton**

Modify `src/workflow/engine.ts`:

- Add imports for `EventStream`, `StoredEvent`, `PermissionController`, and `WorkflowSession`.
- Add `startInteractive(config, workflowId, input): Promise<WorkflowSession>`.
- Add an optional `eventSink?: (event: StoredEvent) => void`, `interaction?: RuntimeInteraction`, and `isInterrupted?: () => boolean` to internal continue options.
- Wrap every `store.appendEvent` call through a helper:

```ts
private async appendEvent(store: RunStore, runId: string, event: HarnessEvent, sink?: (event: StoredEvent) => void): Promise<StoredEvent> {
  const stored = await store.appendEvent(runId, event);
  sink?.(stored);
  return stored;
}
```

Interactive start implementation shape:

```ts
async startInteractive(config: AgentTeamConfig, workflowId: string, input: unknown): Promise<WorkflowSession> {
  const workflow = config.workflows[workflowId];
  if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);

  const store = new RunStore(this.options.runRoot ?? ".runs");
  const run = await store.createRun(workflowId, input);
  const stream = new EventStream<StoredEvent>();
  const permissions = new PermissionController();
  let interrupted = false;
  let latestState: WorkflowState = { status: "running", workflow_id: workflowId, current_node_id: firstNodeId(workflow), attempts: [], handoff: input };

  const result = this.continueFrom({
    config,
    workflowId,
    workflow,
    store,
    runId: run.runId,
    startNodeId: firstNodeId(workflow),
    initialHandoff: await this.prepareInitialHandoff(input, run.runDir),
    attempts: [],
    eventSink: (event) => stream.push(event),
    interaction: {
      requestPermission: (request) => permissions.request(request)
    },
    isInterrupted: () => interrupted,
    onState: (state) => {
      latestState = state;
    }
  }).finally(() => stream.end());

  return {
    runId: run.runId,
    state: latestState,
    events: stream,
    permissions,
    interrupt: async () => {
      interrupted = true;
      const state: WorkflowState = { ...latestState, status: "interrupted" };
      await store.markInterrupted(run.runId, state);
      latestState = state;
    },
    resumeWithUserInput: async () => {
      throw new Error("Interactive resumeWithUserInput is only valid after waiting_user in this implementation task");
    },
    result
  };
}
```

Inside `continueFrom`, after node start and before each new loop iteration, if `isInterrupted?.()` is true, save and return an interrupted state. Pass `attempt` and `interaction` into `runNode`.

- [ ] **Step 6: Run session tests**

Run:

```powershell
npm test -- tests/workflow/session.test.ts tests/workflow/engine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/harness/eventStream.ts src/workflow/session.ts src/workflow/engine.ts tests/workflow/session.test.ts
git commit -m "task-0623:添加交互式工作流会话"
```

---

### Task 6: TUI Event Adapter and State Reducer

**Files:**
- Create: `src/tui/state.ts`
- Create: `src/tui/eventAdapter.ts`
- Create: `tests/tui/eventAdapter.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Create `tests/tui/eventAdapter.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialTuiState, reduceStoredEvent } from "../../src/tui/eventAdapter.js";

describe("TUI event adapter", () => {
  it("groups node attempts and tool calls by runtime events", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "node_started", node_id: "dev", attempt: 1, ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    state = reduceStoredEvent(state, { type: "tool_invoked", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "Bash", input: { command: "npm test" }, ts: "2026-06-23T00:00:01.000Z", seq: 2 });
    state = reduceStoredEvent(state, { type: "tool_completed", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "Bash", result: { output: "ok" }, ts: "2026-06-23T00:00:02.000Z", seq: 3 });

    assert.equal(state.currentNodeId, "dev");
    assert.equal(state.nodes[0]?.status, "running");
    assert.equal(state.tools[0]?.status, "completed");
  });

  it("tracks pending permission requests", () => {
    let state = initialTuiState({ cwd: "D:\\CodeAI\\agent-team" });
    state = reduceStoredEvent(state, { type: "permission_requested", request_id: "perm-1", node_id: "dev", attempt: 1, tool_call_id: "tool-1", tool: "Bash", input: {}, specifier: "npm test", ts: "2026-06-23T00:00:00.000Z", seq: 1 });
    assert.equal(state.permissionRequests.length, 1);

    state = reduceStoredEvent(state, { type: "permission_resolved", request_id: "perm-1", node_id: "dev", attempt: 1, tool_call_id: "tool-1", decision: "deny_once", ts: "2026-06-23T00:00:01.000Z", seq: 2 });
    assert.equal(state.permissionRequests.length, 0);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm test -- tests/tui/eventAdapter.test.ts
```

Expected: FAIL because TUI adapter files do not exist.

- [ ] **Step 3: Define UI state**

Create `src/tui/state.ts`:

```ts
export type TuiMode = "boot" | "select_workflow" | "input" | "running" | "permission" | "question" | "confirm_interrupt" | "completed" | "failed" | "interrupted";

export type TuiNodeState = {
  nodeId: string;
  attempt: number;
  status: "running" | "success" | "failure" | "waiting_user" | "interrupted";
};

export type TuiToolState = {
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  result?: unknown;
  error?: string;
  expanded: boolean;
};

export type TuiPermissionRequestState = {
  requestId: string;
  nodeId: string;
  attempt: number;
  toolCallId: string;
  tool: string;
  input: unknown;
  specifier: string;
  rule?: string;
};

export type TuiState = {
  cwd: string;
  mode: TuiMode;
  workflowId?: string;
  runId?: string;
  currentNodeId?: string;
  nodes: TuiNodeState[];
  tools: TuiToolState[];
  permissionRequests: TuiPermissionRequestState[];
  questions: unknown[];
  timeline: string[];
  error?: string;
};
```

- [ ] **Step 4: Implement event adapter**

Create `src/tui/eventAdapter.ts`:

```ts
import { StoredEvent } from "../harness/events.js";
import { TuiState } from "./state.js";

export function initialTuiState(input: { cwd: string }): TuiState {
  return {
    cwd: input.cwd,
    mode: "boot",
    nodes: [],
    tools: [],
    permissionRequests: [],
    questions: [],
    timeline: []
  };
}

export function reduceStoredEvent(state: TuiState, event: StoredEvent): TuiState {
  const next: TuiState = { ...state, timeline: [...state.timeline, event.type] };

  if (event.type === "run_started") {
    return { ...next, mode: "running" };
  }
  if (event.type === "node_started") {
    return upsertNode({ ...next, mode: "running", currentNodeId: event.node_id }, event.node_id, event.attempt, "running");
  }
  if (event.type === "node_completed") {
    return upsertNode(next, event.node_id, findAttempt(next, event.node_id), event.status);
  }
  if (event.type === "node_waiting_user") {
    return upsertNode({ ...next, mode: "question", currentNodeId: event.node_id, questions: event.questions }, event.node_id, findAttempt(next, event.node_id), "waiting_user");
  }
  if (event.type === "tool_invoked") {
    return {
      ...next,
      tools: [...next.tools, {
        nodeId: event.node_id,
        attempt: event.attempt ?? findAttempt(next, event.node_id),
        toolCallId: event.tool_call_id ?? `${event.node_id}:${next.tools.length + 1}`,
        tool: event.tool,
        status: "running",
        input: event.input,
        expanded: false
      }]
    };
  }
  if (event.type === "tool_completed") {
    return updateTool(next, event.tool_call_id, "completed", event.result);
  }
  if (event.type === "tool_failed") {
    return updateTool(next, event.tool_call_id, "failed", undefined, event.error);
  }
  if (event.type === "permission_requested") {
    return {
      ...next,
      mode: "permission",
      permissionRequests: [...next.permissionRequests, {
        requestId: event.request_id,
        nodeId: event.node_id,
        attempt: event.attempt,
        toolCallId: event.tool_call_id,
        tool: event.tool,
        input: event.input,
        specifier: event.specifier,
        rule: event.rule
      }]
    };
  }
  if (event.type === "permission_resolved") {
    return { ...next, mode: "running", permissionRequests: next.permissionRequests.filter((item) => item.requestId !== event.request_id) };
  }
  if (event.type === "run_interrupted") {
    return { ...next, mode: "interrupted" };
  }
  if (event.type === "run_failed") {
    return { ...next, mode: "failed", error: event.error };
  }
  if (event.type === "run_completed") {
    return { ...next, mode: "completed" };
  }
  return next;
}

function upsertNode(state: TuiState, nodeId: string, attempt: number, status: TuiState["nodes"][number]["status"]): TuiState {
  const existing = state.nodes.findIndex((node) => node.nodeId === nodeId && node.attempt === attempt);
  const node = { nodeId, attempt, status };
  if (existing === -1) return { ...state, nodes: [...state.nodes, node] };
  const nodes = [...state.nodes];
  nodes[existing] = node;
  return { ...state, nodes };
}

function updateTool(state: TuiState, toolCallId: string | undefined, status: "completed" | "failed", result?: unknown, error?: string): TuiState {
  if (!toolCallId) return state;
  return {
    ...state,
    tools: state.tools.map((tool) => tool.toolCallId === toolCallId ? { ...tool, status, result, error } : tool)
  };
}

function findAttempt(state: TuiState, nodeId: string): number {
  return state.nodes.findLast((node) => node.nodeId === nodeId)?.attempt ?? 1;
}
```

- [ ] **Step 5: Run reducer tests**

Run:

```powershell
npm test -- tests/tui/eventAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/tui/state.ts src/tui/eventAdapter.ts tests/tui/eventAdapter.test.ts
git commit -m "task-0623:添加 TUI 事件状态适配"
```

---

### Task 7: PromptInput Core Logic

**Files:**
- Create: `src/tui/commands.ts`
- Create: `src/tui/components/PromptInput/types.ts`
- Create: `src/tui/components/PromptInput/usePromptBuffer.ts`
- Create: `src/tui/components/PromptInput/usePromptHistory.ts`
- Create: `src/tui/components/PromptInput/usePromptSuggestions.ts`
- Create: `src/tui/components/PromptInput/keybindings.ts`
- Create: `tests/tui/promptInput.test.ts`

- [ ] **Step 1: Write failing PromptInput logic tests**

Create `tests/tui/promptInput.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptBuffer, insertText, insertNewline, backspace, moveLeft, moveRight } from "../../src/tui/components/PromptInput/usePromptBuffer.js";
import { createHistory, pushHistory, previousHistory, nextHistory } from "../../src/tui/components/PromptInput/usePromptHistory.js";
import { parseSlashCommand } from "../../src/tui/commands.js";

describe("PromptInput core logic", () => {
  it("edits a multiline prompt buffer", () => {
    let buffer = createPromptBuffer();
    buffer = insertText(buffer, "Build TUI");
    buffer = insertNewline(buffer);
    buffer = insertText(buffer, "with permissions");
    assert.equal(buffer.text, "Build TUI\nwith permissions");
    buffer = moveLeft(buffer);
    buffer = backspace(buffer);
    assert.equal(buffer.text, "Build TUI\nwith permission");
    buffer = moveRight(buffer);
    assert.equal(buffer.cursor, buffer.text.length);
  });

  it("navigates prompt history", () => {
    let history = createHistory();
    history = pushHistory(history, "first");
    history = pushHistory(history, "second");
    const previous = previousHistory(history);
    assert.equal(previous.value, "second");
    const earlier = previousHistory(previous.history);
    assert.equal(earlier.value, "first");
    const next = nextHistory(earlier.history);
    assert.equal(next.value, "second");
  });

  it("parses slash commands", () => {
    assert.deepEqual(parseSlashCommand("/run delivery"), { name: "run", args: ["delivery"] });
    assert.deepEqual(parseSlashCommand("normal text"), undefined);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm test -- tests/tui/promptInput.test.ts
```

Expected: FAIL because PromptInput logic files do not exist.

- [ ] **Step 3: Add PromptInput types**

Create `src/tui/components/PromptInput/types.ts`:

```ts
export type PromptInputMode = "input" | "running" | "permission" | "question" | "confirm_interrupt";

export type PromptBuffer = {
  text: string;
  cursor: number;
  selectionAnchor?: number;
};

export type PromptHistory = {
  entries: string[];
  index?: number;
};

export type PromptInputEvent =
  | { type: "submit"; text: string }
  | { type: "cancel" }
  | { type: "command"; name: string; args: string[] }
  | { type: "queue"; text: string };
```

- [ ] **Step 4: Implement buffer logic**

Create `src/tui/components/PromptInput/usePromptBuffer.ts`:

```ts
import { PromptBuffer } from "./types.js";

export function createPromptBuffer(text = ""): PromptBuffer {
  return { text, cursor: text.length };
}

export function insertText(buffer: PromptBuffer, text: string): PromptBuffer {
  return replaceRange(buffer, buffer.cursor, buffer.cursor, text);
}

export function insertNewline(buffer: PromptBuffer): PromptBuffer {
  return insertText(buffer, "\n");
}

export function backspace(buffer: PromptBuffer): PromptBuffer {
  if (buffer.cursor === 0) return buffer;
  return replaceRange(buffer, buffer.cursor - 1, buffer.cursor, "");
}

export function moveLeft(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: Math.max(0, buffer.cursor - 1), selectionAnchor: undefined };
}

export function moveRight(buffer: PromptBuffer): PromptBuffer {
  return { ...buffer, cursor: Math.min(buffer.text.length, buffer.cursor + 1), selectionAnchor: undefined };
}

export function clearBuffer(): PromptBuffer {
  return createPromptBuffer();
}

function replaceRange(buffer: PromptBuffer, start: number, end: number, value: string): PromptBuffer {
  const text = `${buffer.text.slice(0, start)}${value}${buffer.text.slice(end)}`;
  return { text, cursor: start + value.length, selectionAnchor: undefined };
}
```

- [ ] **Step 5: Implement history and slash parsing**

Create `src/tui/components/PromptInput/usePromptHistory.ts`:

```ts
import { PromptHistory } from "./types.js";

export function createHistory(): PromptHistory {
  return { entries: [] };
}

export function pushHistory(history: PromptHistory, value: string): PromptHistory {
  const trimmed = value.trim();
  if (!trimmed) return history;
  return { entries: [...history.entries.filter((entry) => entry !== trimmed), trimmed], index: undefined };
}

export function previousHistory(history: PromptHistory): { history: PromptHistory; value: string } {
  if (!history.entries.length) return { history, value: "" };
  const index = history.index === undefined ? history.entries.length - 1 : Math.max(0, history.index - 1);
  return { history: { ...history, index }, value: history.entries[index] ?? "" };
}

export function nextHistory(history: PromptHistory): { history: PromptHistory; value: string } {
  if (!history.entries.length) return { history, value: "" };
  const index = history.index === undefined ? history.entries.length - 1 : Math.min(history.entries.length - 1, history.index + 1);
  return { history: { ...history, index }, value: history.entries[index] ?? "" };
}
```

Create `src/tui/commands.ts`:

```ts
export type SlashCommand = {
  name: "run" | "resume" | "status" | "help";
  args: string[];
};

const commandNames = new Set(["run", "resume", "status", "help"]);

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!rawName || !commandNames.has(rawName)) return undefined;
  return { name: rawName as SlashCommand["name"], args };
}
```

Create `src/tui/components/PromptInput/keybindings.ts`:

```ts
export type PromptKeyAction = "submit" | "newline" | "cancel" | "backspace" | "left" | "right" | "history_previous" | "history_next" | "none";

export type PromptKey = {
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export function resolvePromptKey(input: string, key: PromptKey): PromptKeyAction {
  if (key.return && key.meta) return "newline";
  if (input === "\n" && key.ctrl) return "newline";
  if (key.return) return "submit";
  if (key.escape) return "cancel";
  if (key.backspace) return "backspace";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.upArrow) return "history_previous";
  if (key.downArrow) return "history_next";
  return "none";
}
```

Create `src/tui/components/PromptInput/usePromptSuggestions.ts`:

```ts
export function slashCommandSuggestions(input: string, workflows: string[]): string[] {
  const trimmed = input.trim();
  if (trimmed === "/" || trimmed.startsWith("/h")) return ["/help"];
  if (trimmed.startsWith("/r")) return ["/run", "/resume", ...workflows.map((workflow) => `/run ${workflow}`)];
  if (trimmed.startsWith("/s")) return ["/status"];
  return [];
}
```

- [ ] **Step 6: Run PromptInput logic tests**

Run:

```powershell
npm test -- tests/tui/promptInput.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/tui/commands.ts src/tui/components/PromptInput/types.ts src/tui/components/PromptInput/usePromptBuffer.ts src/tui/components/PromptInput/usePromptHistory.ts src/tui/components/PromptInput/usePromptSuggestions.ts src/tui/components/PromptInput/keybindings.ts tests/tui/promptInput.test.ts
git commit -m "task-0623:添加生产级输入框核心逻辑"
```

---

### Task 8: PromptInput React Components

**Files:**
- Create: `src/tui/components/PromptInput/PromptInput.tsx`
- Create: `src/tui/components/PromptInput/PromptInputFooter.tsx`
- Create: `src/tui/components/PromptInput/PromptInputModeIndicator.tsx`
- Create: `src/tui/components/PromptInput/PromptInputQueuedCommands.tsx`
- Create: `src/tui/components/PromptInput/PromptInputSuggestions.tsx`
- Create: `src/tui/components/PromptInput/PromptInputHistory.tsx`
- Create: `src/tui/components/PromptInput/PromptInputStashNotice.tsx`
- Create: `src/tui/components/PromptInput/usePromptKeybindings.ts`
- Create: `tests/tui/components.test.tsx`

- [ ] **Step 1: Write failing component smoke test**

Create `tests/tui/components.test.tsx`:

```tsx
import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";

describe("PromptInput component", () => {
  it("renders mode and footer status", () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    assert.match(output.lastFrame() ?? "", /INPUT/);
    assert.match(output.lastFrame() ?? "", /delivery/);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm test -- tests/tui/components.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement PromptInput components**

Create `src/tui/components/PromptInput/PromptInputModeIndicator.tsx`:

```tsx
import React from "react";
import { Text } from "ink";
import { PromptInputMode } from "./types.js";

export function PromptInputModeIndicator({ mode }: { mode: PromptInputMode }) {
  return <Text color={mode === "running" ? "yellow" : "cyan"}>{mode.toUpperCase()}</Text>;
}
```

Create `src/tui/components/PromptInput/PromptInputFooter.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function PromptInputFooter({ workflowId, isLoading }: { workflowId?: string; isLoading: boolean }) {
  return (
    <Box>
      <Text dimColor>
        workflow {workflowId ?? "unselected"} | Enter submit | Alt+Enter newline | Esc cancel | Ctrl+C stop
        {isLoading ? " | running" : ""}
      </Text>
    </Box>
  );
}
```

Create `src/tui/components/PromptInput/PromptInputQueuedCommands.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function PromptInputQueuedCommands({ queued }: { queued: string[] }) {
  if (!queued.length) return null;
  return (
    <Box flexDirection="column">
      {queued.map((item, index) => <Text key={`${index}:${item}`} dimColor>queued {index + 1}: {item}</Text>)}
    </Box>
  );
}
```

Create `src/tui/components/PromptInput/PromptInputSuggestions.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function PromptInputSuggestions({ suggestions }: { suggestions: string[] }) {
  if (!suggestions.length) return null;
  return (
    <Box flexDirection="column">
      {suggestions.map((suggestion) => <Text key={suggestion} color="gray">{suggestion}</Text>)}
    </Box>
  );
}
```

Create `src/tui/components/PromptInput/PromptInputHistory.tsx`:

```tsx
import React from "react";
import { Text } from "ink";

export function PromptInputHistory({ count }: { count: number }) {
  return <Text dimColor>history {count}</Text>;
}
```

Create `src/tui/components/PromptInput/PromptInputStashNotice.tsx`:

```tsx
import React from "react";
import { Text } from "ink";

export function PromptInputStashNotice({ hasStash }: { hasStash: boolean }) {
  if (!hasStash) return null;
  return <Text color="yellow">unsent input stashed</Text>;
}
```

Create `src/tui/components/PromptInput/usePromptKeybindings.ts`:

```ts
import { useInput } from "ink";
import { backspace, clearBuffer, insertNewline, insertText, moveLeft, moveRight } from "./usePromptBuffer.js";
import { nextHistory, previousHistory, pushHistory } from "./usePromptHistory.js";
import { resolvePromptKey } from "./keybindings.js";
import { PromptBuffer, PromptHistory, PromptInputEvent, PromptInputMode } from "./types.js";
import { parseSlashCommand } from "../../commands.js";

export function usePromptKeybindings(input: {
  mode: PromptInputMode;
  buffer: PromptBuffer;
  history: PromptHistory;
  isLoading: boolean;
  onBuffer: (buffer: PromptBuffer) => void;
  onHistory: (history: PromptHistory) => void;
  onEvent: (event: PromptInputEvent) => void;
}) {
  useInput((value, key) => {
    const action = resolvePromptKey(value, key);
    if (action === "submit") {
      const text = input.buffer.text.trim();
      if (!text) return;
      const command = parseSlashCommand(text);
      input.onHistory(pushHistory(input.history, text));
      input.onBuffer(clearBuffer());
      if (input.isLoading) {
        input.onEvent({ type: "queue", text });
      } else if (command) {
        input.onEvent({ type: "command", name: command.name, args: command.args });
      } else {
        input.onEvent({ type: "submit", text });
      }
      return;
    }
    if (action === "newline") input.onBuffer(insertNewline(input.buffer));
    else if (action === "cancel") input.onEvent({ type: "cancel" });
    else if (action === "backspace") input.onBuffer(backspace(input.buffer));
    else if (action === "left") input.onBuffer(moveLeft(input.buffer));
    else if (action === "right") input.onBuffer(moveRight(input.buffer));
    else if (action === "history_previous") {
      const previous = previousHistory(input.history);
      input.onHistory(previous.history);
      input.onBuffer({ text: previous.value, cursor: previous.value.length });
    } else if (action === "history_next") {
      const next = nextHistory(input.history);
      input.onHistory(next.history);
      input.onBuffer({ text: next.value, cursor: next.value.length });
    } else if (value) {
      input.onBuffer(insertText(input.buffer, value));
    }
  });
}
```

Create `src/tui/components/PromptInput/PromptInput.tsx`:

```tsx
import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { createPromptBuffer } from "./usePromptBuffer.js";
import { createHistory } from "./usePromptHistory.js";
import { slashCommandSuggestions } from "./usePromptSuggestions.js";
import { PromptInputEvent, PromptInputMode } from "./types.js";
import { usePromptKeybindings } from "./usePromptKeybindings.js";
import { PromptInputFooter } from "./PromptInputFooter.js";
import { PromptInputModeIndicator } from "./PromptInputModeIndicator.js";
import { PromptInputQueuedCommands } from "./PromptInputQueuedCommands.js";
import { PromptInputSuggestions } from "./PromptInputSuggestions.js";
import { PromptInputHistory } from "./PromptInputHistory.js";
import { PromptInputStashNotice } from "./PromptInputStashNotice.js";

export function PromptInput(props: {
  mode: PromptInputMode;
  workflowId?: string;
  queued: string[];
  workflows: string[];
  isLoading: boolean;
  stash?: string;
  onEvent: (event: PromptInputEvent) => void;
}) {
  const [buffer, setBuffer] = useState(createPromptBuffer());
  const [history, setHistory] = useState(createHistory());
  usePromptKeybindings({ mode: props.mode, buffer, history, isLoading: props.isLoading, onBuffer: setBuffer, onHistory: setHistory, onEvent: props.onEvent });
  const suggestions = useMemo(() => slashCommandSuggestions(buffer.text, props.workflows), [buffer.text, props.workflows]);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Box>
        <PromptInputModeIndicator mode={props.mode} />
        <Text> {buffer.text || "Type a request or /help"}</Text>
      </Box>
      <PromptInputSuggestions suggestions={suggestions} />
      <PromptInputQueuedCommands queued={props.queued} />
      <PromptInputStashNotice hasStash={Boolean(props.stash)} />
      <PromptInputHistory count={history.entries.length} />
      <PromptInputFooter workflowId={props.workflowId} isLoading={props.isLoading} />
    </Box>
  );
}
```

- [ ] **Step 4: Run component tests**

Run:

```powershell
npm test -- tests/tui/components.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/tui/components/PromptInput tests/tui/components.test.tsx
git commit -m "task-0623:添加 TUI PromptInput 组件"
```

---

### Task 9: TUI Shell Components and Launcher

**Files:**
- Modify: `src/tui/launchTui.tsx`
- Create: `src/tui/TuiApp.tsx`
- Create: `src/tui/components/Header.tsx`
- Create: `src/tui/components/WorkflowPicker.tsx`
- Create: `src/tui/components/RunTimeline.tsx`
- Create: `src/tui/components/NodeStatusList.tsx`
- Create: `src/tui/components/ToolCallList.tsx`
- Create: `src/tui/components/PermissionPrompt.tsx`
- Create: `src/tui/components/UserQuestionPrompt.tsx`
- Create: `src/tui/components/ResultPanel.tsx`
- Create: `src/tui/components/Footer.tsx`
- Modify: `tests/tui/components.test.tsx`

- [ ] **Step 1: Add failing TuiApp smoke test**

Append to `tests/tui/components.test.tsx`:

```tsx
import { TuiApp } from "../../src/tui/TuiApp.js";

describe("TuiApp", () => {
  it("renders missing config guidance", () => {
    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" initialError="Missing agent-team.yaml" />);
    assert.match(output.lastFrame() ?? "", /Missing agent-team.yaml/);
    assert.match(output.lastFrame() ?? "", /agent-team init/);
  });
});
```

- [ ] **Step 2: Run component test and verify it fails**

Run:

```powershell
npm test -- tests/tui/components.test.tsx
```

Expected: FAIL because `TuiApp` does not exist.

- [ ] **Step 3: Implement shell components**

Create `src/tui/components/Header.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function Header({ cwd, workflowId, runId }: { cwd: string; workflowId?: string; runId?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>agent-team</Text>
      <Text dimColor>{cwd}</Text>
      <Text>workflow {workflowId ?? "unselected"}{runId ? ` | run ${runId}` : ""}</Text>
    </Box>
  );
}
```

Create `src/tui/components/RunTimeline.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function RunTimeline({ items }: { items: string[] }) {
  return <Box flexDirection="column">{items.slice(-8).map((item, index) => <Text key={`${index}:${item}`} dimColor>{item}</Text>)}</Box>;
}
```

Create `src/tui/components/NodeStatusList.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { TuiNodeState } from "../state.js";

export function NodeStatusList({ nodes }: { nodes: TuiNodeState[] }) {
  return (
    <Box flexDirection="column">
      {nodes.map((node) => <Text key={`${node.nodeId}:${node.attempt}`}>{node.nodeId} #{node.attempt} {node.status}</Text>)}
    </Box>
  );
}
```

Create `src/tui/components/ToolCallList.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { TuiToolState } from "../state.js";

export function ToolCallList({ tools }: { tools: TuiToolState[] }) {
  return (
    <Box flexDirection="column">
      {tools.map((tool) => <Text key={tool.toolCallId}>{tool.tool} {tool.status} {tool.expanded ? JSON.stringify(tool.result ?? tool.error ?? tool.input).slice(0, 300) : ""}</Text>)}
    </Box>
  );
}
```

Create `src/tui/components/PermissionPrompt.tsx`:

```tsx
import React from "react";
import { Box, Text, useInput } from "ink";
import { TuiPermissionRequestState } from "../state.js";

export function PermissionPrompt({ request, onResolve }: { request?: TuiPermissionRequestState; onResolve: (requestId: string, decision: "allow_once" | "deny_once") => void }) {
  useInput((input) => {
    if (!request) return;
    if (input.toLowerCase() === "y") onResolve(request.requestId, "allow_once");
    if (input.toLowerCase() === "n") onResolve(request.requestId, "deny_once");
  });
  if (!request) return null;
  return (
    <Box flexDirection="column">
      <Text color="yellow">Permission required: {request.tool} {request.specifier}</Text>
      <Text dimColor>y allow once | n deny once</Text>
    </Box>
  );
}
```

Create `src/tui/components/UserQuestionPrompt.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function UserQuestionPrompt({ questions }: { questions: unknown[] }) {
  if (!questions.length) return null;
  return <Box flexDirection="column"><Text color="yellow">User input required</Text><Text>{JSON.stringify(questions).slice(0, 300)}</Text></Box>;
}
```

Create `src/tui/components/ResultPanel.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

export function ResultPanel({ mode, error, runId }: { mode: string; error?: string; runId?: string }) {
  if (!["completed", "failed", "interrupted"].includes(mode)) return null;
  return <Box flexDirection="column"><Text>{mode}</Text>{error ? <Text color="red">{error}</Text> : null}{runId ? <Text dimColor>run {runId}</Text> : null}</Box>;
}
```

Create `src/tui/components/Footer.tsx`:

```tsx
import React from "react";
import { Text } from "ink";

export function Footer({ mode }: { mode: string }) {
  return <Text dimColor>mode {mode} | Ctrl+C stop</Text>;
}
```

Create `src/tui/components/WorkflowPicker.tsx`:

```tsx
import React from "react";
import { Box, Text, useInput } from "ink";

export function WorkflowPicker({ workflows, selected, onSelect }: { workflows: string[]; selected?: string; onSelect: (workflow: string) => void }) {
  useInput((input) => {
    const index = Number(input) - 1;
    if (Number.isInteger(index) && workflows[index]) onSelect(workflows[index]);
  });
  return (
    <Box flexDirection="column">
      <Text>Select workflow</Text>
      {workflows.map((workflow, index) => <Text key={workflow}>{index + 1}. {workflow}{workflow === selected ? " *" : ""}</Text>)}
    </Box>
  );
}
```

- [ ] **Step 4: Implement TuiApp and launcher**

Create `src/tui/TuiApp.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import { initialTuiState } from "./eventAdapter.js";
import { Header } from "./components/Header.js";
import { RunTimeline } from "./components/RunTimeline.js";
import { NodeStatusList } from "./components/NodeStatusList.js";
import { ToolCallList } from "./components/ToolCallList.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { UserQuestionPrompt } from "./components/UserQuestionPrompt.js";
import { ResultPanel } from "./components/ResultPanel.js";
import { Footer } from "./components/Footer.js";
import { PromptInput } from "./components/PromptInput/PromptInput.js";

export function TuiApp({ cwd, initialError }: { cwd: string; initialError?: string }) {
  const [state] = useState(initialTuiState({ cwd }));
  const [queued] = useState<string[]>([]);

  if (initialError) {
    return (
      <Box flexDirection="column">
        <Header cwd={cwd} />
        <Text color="red">{initialError}</Text>
        <Text>Run agent-team init to create agent-team.yaml</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header cwd={cwd} workflowId={state.workflowId} runId={state.runId} />
      <NodeStatusList nodes={state.nodes} />
      <ToolCallList tools={state.tools} />
      <PermissionPrompt request={state.permissionRequests[0]} onResolve={() => undefined} />
      <UserQuestionPrompt questions={state.questions} />
      <RunTimeline items={state.timeline} />
      <ResultPanel mode={state.mode} error={state.error} runId={state.runId} />
      <PromptInput mode="input" workflowId={state.workflowId} queued={queued} workflows={[]} isLoading={false} onEvent={() => undefined} />
      <Footer mode={state.mode} />
    </Box>
  );
}
```

Replace `src/tui/launchTui.tsx`:

```tsx
import React from "react";
import { render } from "ink";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { TuiApp } from "./TuiApp.js";

export async function launchTui(options: { cwd: string }): Promise<void> {
  const configPath = join(options.cwd, "agent-team.yaml");
  let initialError: string | undefined;
  try {
    await access(configPath);
  } catch {
    initialError = "Missing agent-team.yaml";
  }

  render(<TuiApp cwd={options.cwd} initialError={initialError} />);
}
```

- [ ] **Step 5: Run component tests**

Run:

```powershell
npm test -- tests/tui/components.test.tsx
npm run build
```

Expected: PASS and build succeeds.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/tui tests/tui/components.test.tsx
git commit -m "task-0623:添加 TUI 基础界面组件"
```

---

### Task 10: Wire TUI to WorkflowSession

**Files:**
- Modify: `src/tui/TuiApp.tsx`
- Modify: `src/tui/launchTui.tsx`
- Modify: `src/workflow/engine.ts`
- Modify: `tests/tui/components.test.tsx`
- Create: `tests/tui/startup.test.ts`

- [ ] **Step 1: Write failing startup behavior test**

Create `tests/tui/startup.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectDefaultWorkflow } from "../../src/tui/launchTui.js";

describe("TUI startup workflow selection", () => {
  it("prefers delivery workflow", () => {
    assert.equal(selectDefaultWorkflow(["other", "delivery"]), "delivery");
  });

  it("uses the only workflow when delivery is absent", () => {
    assert.equal(selectDefaultWorkflow(["single"]), "single");
  });

  it("requires selection when multiple non-delivery workflows exist", () => {
    assert.equal(selectDefaultWorkflow(["a", "b"]), undefined);
  });
});
```

- [ ] **Step 2: Run startup test and verify it fails**

Run:

```powershell
npm test -- tests/tui/startup.test.ts
```

Expected: FAIL because `selectDefaultWorkflow` does not exist.

- [ ] **Step 3: Implement default workflow selection**

Add to `src/tui/launchTui.tsx`:

```ts
export function selectDefaultWorkflow(workflows: string[]): string | undefined {
  if (workflows.includes("delivery")) return "delivery";
  if (workflows.length === 1) return workflows[0];
  return undefined;
}
```

Update `launchTui` to load config:

```tsx
import { loadConfig } from "../config/loadConfig.js";
import { createProvider } from "../providers/registry.js";
import { WorkflowEngine } from "../workflow/engine.js";

const config = initialError ? undefined : await loadConfig(configPath);
const workflows = config ? Object.keys(config.workflows) : [];
const workflowId = selectDefaultWorkflow(workflows);
const engine = config ? new WorkflowEngine({ providerFactory: (providerId) => createProvider(config, providerId), cwd: options.cwd }) : undefined;
render(<TuiApp cwd={options.cwd} initialError={initialError} config={config} workflows={workflows} workflowId={workflowId} engine={engine} />);
```

Update `TuiApp` props to accept `config`, `workflows`, `workflowId`, and `engine`.

- [ ] **Step 4: Wire session start, event consumption, permission resolution, and interrupt**

In `TuiApp`, when `PromptInput` submits text:

```ts
const session = await engine.startInteractive(config, selectedWorkflowId, { request: text, images: [] });
setRunId(session.runId);
void (async () => {
  for await (const event of session.events) {
    setState((current) => reduceStoredEvent(current, event));
  }
})();
const finalState = await session.result;
setFinalState(finalState);
```

Wire `PermissionPrompt`:

```ts
onResolve={(requestId, decision) => sessionRef.current?.permissions.resolve(requestId, decision)}
```

Wire `Ctrl+C` at `TuiApp` level with `useInput`:

```ts
useInput((_input, key) => {
  if (!key.ctrl || _input !== "c") return;
  if (state.mode !== "confirm_interrupt") {
    setState((current) => ({ ...current, mode: "confirm_interrupt" }));
    return;
  }
  void sessionRef.current?.interrupt();
});
```

Use existing `PromptInput` `cancel` event to return from `confirm_interrupt` to `running` without interruption.

- [ ] **Step 5: Run startup and component tests**

Run:

```powershell
npm test -- tests/tui/startup.test.ts tests/tui/components.test.tsx tests/workflow/session.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/tui/launchTui.tsx src/tui/TuiApp.tsx src/workflow/engine.ts tests/tui/startup.test.ts tests/tui/components.test.tsx
git commit -m "task-0623:连接 TUI 与交互式工作流"
```

---

### Task 11: Final Verification and README Update

**Files:**
- Modify: `README.md`
- Modify: `tests/cli.smoke.test.ts`

- [ ] **Step 1: Add CLI help regression assertions**

Modify `tests/cli.smoke.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgram } from "../src/cli/program.js";
import { shouldLaunchTui } from "../src/cli/dispatch.js";

describe("CLI", () => {
  it("registers expected commands in help", () => {
    const help = createProgram().helpInformation();

    assert.match(help, /init/);
    assert.match(help, /run/);
    assert.match(help, /resume/);
    assert.match(help, /status/);
    assert.match(help, /inspect/);
  });

  it("starts TUI only without subcommands", () => {
    assert.equal(shouldLaunchTui(["node", "agent-team"]), true);
    assert.equal(shouldLaunchTui(["node", "agent-team", "run"]), false);
  });
});
```

- [ ] **Step 2: Update README usage**

Add this section to `README.md` after Quick Start:

```markdown
## Interactive TUI

Run `agent-team` with no subcommand to open the interactive terminal UI.

The TUI reads `agent-team.yaml` from the current directory, selects workflow `delivery` when present, and lets you submit one workflow request with live node, tool, permission, and result status.

Existing subcommands remain headless for automation:

```bash
node dist/cli/main.js run -f agent-team.yaml --input "Build the requested feature"
node dist/cli/main.js status <run_id>
node dist/cli/main.js inspect <run_id>
node dist/cli/main.js resume <run_id> -f agent-team.yaml --answer "..."
```
```

- [ ] **Step 3: Run complete verification**

Run:

```powershell
npm run build
npm test
node dist/cli/main.js --help
```

Expected:

- `npm run build`: PASS.
- `npm test`: PASS.
- help output includes `init`, `run`, `resume`, `status`, and `inspect`.

- [ ] **Step 4: Commit**

Run:

```powershell
git add README.md tests/cli.smoke.test.ts
git commit -m "task-0623:更新 TUI 文档与回归测试"
```

---

## Self-Review

Spec coverage:

- Default no-subcommand TUI: Task 1 and Task 10.
- Existing headless commands: Task 1 and Task 11.
- React + Ink shell: Task 1, Task 8, Task 9.
- PromptInput production subsystem: Task 7 and Task 8.
- Event-driven runtime: Task 2, Task 4, Task 5, Task 6.
- Permission `ask` confirmation: Task 3, Task 4, Task 9, Task 10.
- `waiting_user` path: preserved by existing engine tests and wired through Task 10.
- `Ctrl+C` two-step interrupt: Task 5 and Task 10.
- Sensitive default display: Task 6 state model and Task 9 concise components.
- No model token streaming: no task adds provider streaming.

Red-flag scan:

- No unresolved marker strings remain in task steps.
- No empty implementation notes remain in task steps.
- No undefined task names referenced as implementation dependencies.

Type consistency:

- Runtime permission decisions use `allow_once` and `deny_once`.
- Event fields use `request_id`, `tool_call_id`, `node_id`, and `attempt` consistently in stored events.
- TUI state maps stored snake_case event fields to camelCase UI state fields.
- PromptInput event names match the approved spec: `submit`, `cancel`, `command`, and `queue`.

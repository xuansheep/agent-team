# TUI Code Skills MCP Hooks Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/skills`, `/hooks`, and `/mcp` TUI commands aligned with `D:\work\code-ai\tui-code`, including real MCP enable/disable/reconnect state changes.

**Architecture:** Keep the existing registry, `TuiApp` command branch, runtime diagnostics, and `InteractionArea` model. Add source-aware MCP config mutation helpers, runtime control methods, and pure menu builders consumed by a thin TUI integration layer.

**Tech Stack:** TypeScript, React Ink, Node `node:test`, `js-yaml`, existing MCP/Skill/Hook runtimes, existing `InteractionChoice` controls.

---

## File Map

- Modify `src/commands/registry.ts`: add command names/actions for `skills`, `hooks`, `mcp`.
- Modify `src/tui/commandCompletion.ts`: add `/mcp enable|disable|reconnect` completion.
- Modify `src/mcp/schema.ts`: add optional `sourcePath` and `sourceFormat` to `ResolvedMcpServerConfig`.
- Modify `src/mcp/config.ts`: expose source details and source-aware merge/load helpers.
- Create `src/mcp/configMutations.ts`: write `disabled` to the effective JSON/YAML source.
- Modify `src/mcp/runtime.ts`: add `disconnect`, `reconnect`, richer diagnostics, tool diagnostics.
- Create `src/tui/commandMenus/skillsMenu.ts`, `hooksMenu.ts`, `mcpMenu.ts`, `index.ts`: pure menu builders.
- Modify `src/tui/TuiApp.tsx`: add command menu state and MCP action wiring.
- Modify `src/tui/launchTui.tsx`: pass source-aware MCP config options to `TuiApp`.
- Tests: update existing registry/completion/MCP/runtime/diagnostics tests and add `tests/tui/commandMenus.test.ts`, `tests/tui/tuiAppCommandMenus.test.tsx`.

---

### Task 1: Register Slash Commands

**Files:**
- Modify: `src/commands/registry.ts:1-36`
- Modify: `src/tui/commandCompletion.ts:1-35`
- Test: `tests/commands/registry.test.ts`
- Test: `tests/tui/commandCompletion.test.ts`

- [ ] **Step 1: Write failing registry tests**

Add to `tests/commands/registry.test.ts`:

```ts
it("parses skills, hooks, and mcp commands", () => {
  assert.deepEqual(parseCommandAction("/skills"), { type: "skills", args: [] });
  assert.deepEqual(parseCommandAction("/hooks"), { type: "hooks", args: [] });
  assert.deepEqual(parseCommandAction("/mcp"), { type: "mcp", args: [] });
  assert.deepEqual(parseCommandAction("/mcp enable docs"), { type: "mcp", args: ["enable", "docs"], subcommand: "enable", serverName: "docs" });
  assert.deepEqual(parseCommandAction("/mcp disable"), { type: "mcp", args: ["disable"], subcommand: "disable", serverName: undefined });
  assert.deepEqual(parseCommandAction("/mcp reconnect docs"), { type: "mcp", args: ["reconnect", "docs"], subcommand: "reconnect", serverName: "docs" });
});

it("exposes stable command names for TUI completion", () => {
  assert.deepEqual(commandNames(), ["clear", "diagnostics", "help", "hooks", "mcp", "model", "new", "permissions", "plan", "resume", "skills", "statusline"]);
});
```

Add to `tests/tui/commandCompletion.test.ts`:

```ts
it("suggests skills, hooks, mcp, and mcp subcommands", () => {
  assert.deepEqual(slashCommandSuggestions("/sk", context).map((item) => item.value), ["/skills"]);
  assert.deepEqual(slashCommandSuggestions("/ho", context).map((item) => item.value), ["/hooks"]);
  assert.deepEqual(slashCommandSuggestions("/mc", context).map((item) => item.value), ["/mcp"]);
  assert.deepEqual(slashCommandSuggestions("/mcp e", context).map((item) => item.value), ["/mcp enable"]);
  assert.deepEqual(slashCommandSuggestions("/mcp d", context).map((item) => item.value), ["/mcp disable"]);
  assert.deepEqual(slashCommandSuggestions("/mcp r", context).map((item) => item.value), ["/mcp reconnect"]);
});
```

- [ ] **Step 2: Run tests and see failure**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/commands/registry.test.ts tests/tui/commandCompletion.test.ts
```

Expected: build or tests fail because commands are not registered.

- [ ] **Step 3: Implement registry and completion**

In `src/commands/registry.ts`, extend `CommandName`:

```ts
export type CommandName = "clear" | "diagnostics" | "help" | "hooks" | "mcp" | "model" | "new" | "permissions" | "plan" | "resume" | "skills" | "statusline";
```

Add `CommandAction` variants:

```ts
  | { type: "hooks"; args: string[] }
  | { type: "mcp"; args: string[]; subcommand?: "enable" | "disable" | "reconnect"; serverName?: string }
  | { type: "skills"; args: string[] }
```

Add definitions:

```ts
  { name: "hooks", description: "View hook configurations for tool events", parse: (args) => ({ type: "hooks", args }) },
  { name: "mcp", description: "Manage MCP servers", argumentHint: "[enable|disable|reconnect [server-name]]", parse: parseMcpCommand },
  { name: "skills", description: "List available skills", parse: (args) => ({ type: "skills", args }) },
```

Add helper:

```ts
function parseMcpCommand(args: string[]): CommandAction {
  const [candidate, serverName] = args;
  const subcommand = candidate === "enable" || candidate === "disable" || candidate === "reconnect" ? candidate : undefined;
  return { type: "mcp", args, subcommand, serverName: subcommand ? serverName : undefined };
}
```

In `src/tui/commandCompletion.ts`, add:

```ts
  if (commandName === "mcp") return argumentSuggestions("/mcp", ["enable", "disable", "reconnect"], argument, "mcp action");
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/commands/registry.test.ts tests/tui/commandCompletion.test.ts
```

Expected: exit `0`.

Commit:

```bash
git add src/commands/registry.ts src/tui/commandCompletion.ts tests/commands/registry.test.ts tests/tui/commandCompletion.test.ts
git commit -m "feat: register skills mcp hooks slash commands"
```

---

### Task 2: MCP Effective Source Writeback

**Files:**
- Modify: `src/mcp/schema.ts:34-38`
- Modify: `src/mcp/config.ts:1-61`
- Create: `src/mcp/configMutations.ts`
- Test: `tests/mcp/config.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/mcp/config.test.ts`, import:

```ts
import { readFile } from "node:fs/promises";
import { loadMergedMcpServersWithSourceDetails } from "../../src/mcp/config.js";
import { setMcpServerDisabledState } from "../../src/mcp/configMutations.js";
```

Add tests for source paths and writeback:

```ts
it("returns source paths for merged MCP servers", async () => {
  const cwd = await tempWorkspace();
  const userPath = join(cwd, "user-mcp.json");
  const projectPath = join(cwd, ".mcp.json");
  await writeJson(userPath, { mcpServers: { shared: { type: "stdio", command: "user" } } });
  await writeJson(projectPath, { mcpServers: { shared: { type: "stdio", command: "project" } } });
  const merged = await loadMergedMcpServersWithSourceDetails({ cwd, userMcpPath: userPath, projectMcpPath: projectPath });
  assert.equal(merged[0]?.source, "project");
  assert.equal(merged[0]?.sourcePath, projectPath);
  assert.equal(merged[0]?.sourceFormat, "json");
});

it("writes disabled state to the effective JSON source only", async () => {
  const cwd = await tempWorkspace();
  const userPath = join(cwd, "user-mcp.json");
  const projectPath = join(cwd, ".mcp.json");
  await writeJson(userPath, { mcpServers: { shared: { type: "stdio", command: "user" } } });
  await writeJson(projectPath, { mcpServers: { shared: { type: "stdio", command: "project" } } });
  await setMcpServerDisabledState({ cwd, userMcpPath: userPath, projectMcpPath: projectPath }, "shared", true);
  assert.equal(JSON.parse(await readFile(projectPath, "utf8")).mcpServers.shared.disabled, true);
  assert.equal(JSON.parse(await readFile(userPath, "utf8")).mcpServers.shared.disabled, undefined);
});

it("enables JSON servers by removing disabled", async () => {
  const cwd = await tempWorkspace();
  const projectPath = join(cwd, ".mcp.json");
  await writeJson(projectPath, { mcpServers: { docs: { type: "http", url: "https://project.example.test", disabled: true } } });
  await setMcpServerDisabledState({ cwd, projectMcpPath: projectPath }, "docs", false);
  const parsed = JSON.parse(await readFile(projectPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.mcpServers.docs, "disabled"), false);
});

it("throws without creating a missing MCP server", async () => {
  const cwd = await tempWorkspace();
  const projectPath = join(cwd, ".mcp.json");
  await writeJson(projectPath, { mcpServers: { docs: { type: "http", url: "https://project.example.test" } } });
  await assert.rejects(setMcpServerDisabledState({ cwd, projectMcpPath: projectPath }, "missing", true), /Unknown MCP server missing/);
  assert.equal(JSON.parse(await readFile(projectPath, "utf8")).mcpServers.missing, undefined);
});
```

- [ ] **Step 2: Run tests and see failure**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/mcp/config.test.ts
```

Expected: missing exports fail compilation.

- [ ] **Step 3: Implement config metadata**

In `src/mcp/schema.ts`:

```ts
export type ResolvedMcpServerConfig = McpServerConfig & {
  name: string;
  source: "user" | "project" | "agent-team";
  sourcePath?: string;
  sourceFormat?: "json" | "yaml";
};
```

In `src/mcp/config.ts`, export these additions while preserving existing `loadMcpConfigSources`, `mergeMcpServers`, and `loadMergedMcpServers` callers:

```ts
export type McpConfigSourceFormat = "json" | "yaml";
export type McpConfigSourceDetail = { source: ResolvedMcpServerConfig["source"]; path: string; format: McpConfigSourceFormat; servers?: McpServersConfig };
export function defaultProjectMcpPath(cwd: string): string { return join(cwd, ".mcp.json"); }
export function defaultAgentTeamPath(cwd: string): string { return join(cwd, "agent-team.yaml"); }
export async function loadMcpConfigSourceDetails(options: McpConfigSourceOptions): Promise<McpConfigSourceDetail[]> { /* implement user/project JSON plus agent-team YAML source detail */ }
export function mergeMcpServersWithSourceDetails(details: McpConfigSourceDetail[]): ResolvedMcpServerConfig[] { /* merge in user -> project -> agent-team order and attach sourcePath/sourceFormat */ }
export async function loadMergedMcpServersWithSourceDetails(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> { return mergeMcpServersWithSourceDetails(await loadMcpConfigSourceDetails(options)); }
```

Use concrete implementation logic already present in `mergeMcpServers`: each later source overwrites the same server name in the `Map`, then the result is sorted by name.

- [ ] **Step 4: Implement config mutation helper**

Create `src/mcp/configMutations.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { defaultAgentTeamPath, loadMcpConfigSourceDetails, mergeMcpServersWithSourceDetails, type McpConfigSourceOptions } from "./config.js";
import { mcpServersSchema, type McpServerConfig } from "./schema.js";

export type McpConfigMutationResult = { serverName: string; source: "user" | "project" | "agent-team"; sourcePath: string; disabled: boolean };

export async function setMcpServerDisabledState(options: McpConfigSourceOptions, serverName: string, disabled: boolean): Promise<McpConfigMutationResult> {
  const details = await loadMcpConfigSourceDetails(options);
  const effective = mergeMcpServersWithSourceDetails(details).find((server) => server.name === serverName);
  if (!effective) throw new Error(`Unknown MCP server ${serverName}`);
  const detail = details.find((candidate) => candidate.source === effective.source);
  if (!detail) throw new Error(`Missing MCP config source ${effective.source}`);
  if (detail.format === "json") await writeJsonDisabledState(detail.path, serverName, disabled);
  else await writeYamlDisabledState(detail.path || options.agentTeamPath || defaultAgentTeamPath(options.cwd), serverName, disabled);
  return { serverName, source: effective.source, sourcePath: detail.path, disabled };
}

async function writeJsonDisabledState(path: string, serverName: string, disabled: boolean): Promise<void> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
  const server = parsed.mcpServers?.[serverName];
  if (!server) throw new Error(`MCP server ${serverName} is not present in ${path}`);
  if (disabled) server.disabled = true;
  else delete server.disabled;
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function writeYamlDisabledState(path: string, serverName: string, disabled: boolean): Promise<void> {
  const parsed = yaml.load(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> } | undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid YAML object in ${path}`);
  const servers = mcpServersSchema.parse(parsed.mcpServers ?? {});
  const server = servers[serverName];
  if (!server) throw new Error(`MCP server ${serverName} is not present in ${path}`);
  if (disabled) server.disabled = true;
  else delete server.disabled;
  parsed.mcpServers = { ...(parsed.mcpServers ?? {}), [serverName]: server };
  await writeFile(path, yaml.dump(parsed, { lineWidth: -1 }), "utf8");
}
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/mcp/config.test.ts
```

Expected: exit `0`.

Commit:

```bash
git add src/mcp/schema.ts src/mcp/config.ts src/mcp/configMutations.ts tests/mcp/config.test.ts
git commit -m "feat: add effective mcp config writeback"
```

---

### Task 3: MCP Runtime Control

**Files:**
- Modify: `src/mcp/runtime.ts:1-126`
- Test: `tests/mcp/connectionManager.test.ts`
- Test: `tests/diagnostics/runtimeDiagnostics.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests for `disconnect`, `reconnect`, and tool diagnostics in `tests/mcp/connectionManager.test.ts`:

```ts
it("disconnects a server, closes the client, and clears exposed capabilities", async () => {
  let closed = false;
  const runtime = new McpRuntime({ clientFactory: async () => ({ listTools: async () => [{ name: "search" }], callTool: async () => ({}), listResources: async () => [], readResource: async () => ({}), listPrompts: async () => [], getPrompt: async () => ({}), close: async () => { closed = true; } }) });
  await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);
  await runtime.disconnect("docs", "disabled");
  assert.equal(closed, true);
  assert.equal(runtime.getServerStatus("docs")?.state, "disabled");
  assert.deepEqual(runtime.listTools(), []);
});

it("reconnects using the supplied latest config", async () => {
  const created: string[] = [];
  const runtime = new McpRuntime({ clientFactory: async (server) => { created.push(`${server.name}:${server.type}`); return new FakeMcpClient([{ name: "search" }]); } });
  await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://old.example.test" }]);
  await runtime.reconnect({ name: "docs", source: "project", type: "sse", url: "https://new.example.test/sse" });
  assert.deepEqual(created, ["docs:http", "docs:sse"]);
  assert.equal(runtime.getDiagnostics().find((item) => item.name === "docs")?.transport, "sse");
});
```

- [ ] **Step 2: Implement runtime methods**

In `src/mcp/runtime.ts`, extend diagnostics:

```ts
export type McpRuntimeDiagnostic = McpServerStatus & {
  source: ResolvedMcpServerConfig["source"];
  sourcePath?: string;
  sourceFormat?: ResolvedMcpServerConfig["sourceFormat"];
  transport: ResolvedMcpServerConfig["type"];
  disabled?: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
};
export type McpToolDiagnostic = RuntimeMcpTool;
```

Add methods:

```ts
async disconnect(name: string, state: McpServerState = "disabled"): Promise<void> {
  const record = this.servers.get(name);
  if (!record) throw new Error(`Unknown MCP server ${name}`);
  const closeError = await closeClient(record.client);
  record.client = undefined;
  record.tools = [];
  record.resources = [];
  record.prompts = [];
  record.status = closeError ? { name, state, error: closeError } : { name, state };
  if (closeError) throw new Error(closeError);
}

async reconnect(config: ResolvedMcpServerConfig): Promise<void> {
  if (this.servers.has(config.name)) await this.disconnect(config.name, config.disabled ? "disabled" : "pending");
  await this.connect(config);
}

listToolDiagnostics(server?: string): McpToolDiagnostic[] {
  if (!server) return [...this.servers.values()].flatMap((record) => record.tools);
  const record = this.servers.get(server);
  if (!record) throw new Error(`Unknown MCP server ${server}`);
  return record.tools.slice();
}
```

Update `getDiagnostics()` to include `sourcePath`, `sourceFormat`, `transport`, and `disabled`.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/mcp/connectionManager.test.ts tests/diagnostics/runtimeDiagnostics.test.ts
```

Expected: exit `0`.

Commit:

```bash
git add src/mcp/runtime.ts tests/mcp/connectionManager.test.ts tests/diagnostics/runtimeDiagnostics.test.ts
git commit -m "feat: add mcp runtime control methods"
```

---

### Task 4: Pure Menu Builders

**Files:**
- Create: `src/tui/commandMenus/skillsMenu.ts`
- Create: `src/tui/commandMenus/hooksMenu.ts`
- Create: `src/tui/commandMenus/mcpMenu.ts`
- Create: `src/tui/commandMenus/index.ts`
- Test: `tests/tui/commandMenus.test.ts`

- [ ] **Step 1: Write failing builder tests**

Create `tests/tui/commandMenus.test.ts` with assertions that builders return expected titles, values, and detail text:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSkillsDetailChoice, buildSkillsListChoice } from "../../src/tui/commandMenus/skillsMenu.js";
import { buildHooksEventChoice, buildHooksHookChoice, buildHooksHookDetailChoice } from "../../src/tui/commandMenus/hooksMenu.js";
import { buildMcpListChoice, buildMcpServerChoice, buildMcpToolDetailChoice } from "../../src/tui/commandMenus/mcpMenu.js";

const noop = () => undefined;

describe("command menu builders", () => {
  it("builds skills list and detail choices", () => {
    const skills = [{ name: "planner", source: "project" as const, mode: "inline" as const, path: "SKILL.md", allowedTools: ["Read"], hasHooks: true, description: "Plan", whenToUse: "Use before coding" }];
    assert.deepEqual(buildSkillsListChoice({ skills, onSelect: noop, onCancel: noop }).options.map((item) => item.value), ["planner"]);
    assert.match(buildSkillsDetailChoice({ skill: skills[0]!, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /whenToUse: Use before coding/);
  });

  it("builds hook choices", () => {
    const hooks = [{ id: "h1", event: "Stop" as const, matcher: "*", type: "command" as const, source: "settings" as const, command: "verify", wired: true, disabled: true }];
    assert.deepEqual(buildHooksEventChoice({ hooks, onSelect: noop, onCancel: noop }).options.map((item) => item.value), ["Stop"]);
    assert.match(buildHooksHookChoice({ event: "Stop", matcher: "*", hooks, onSelect: noop, onBack: noop, onCancel: noop }).options[0]?.description ?? "", /disabled/);
    assert.match(buildHooksHookDetailChoice({ hook: hooks[0]!, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /disabled: true/);
  });

  it("builds mcp choices", () => {
    const servers = [{ name: "docs", state: "connected" as const, source: "project" as const, sourcePath: "D:/repo/.mcp.json", sourceFormat: "json" as const, transport: "http" as const, toolCount: 1, resourceCount: 0, promptCount: 0 }];
    const tools = [{ server: "docs", name: "mcp__docs__search", originalName: "search", description: "Search", inputSchema: { type: "object" } }];
    assert.equal(buildMcpListChoice({ servers, onSelect: noop, onAction: noop, onCancel: noop }).title, "MCP Servers");
    assert.match(buildMcpServerChoice({ server: servers[0]!, tools, onSelectTools: noop, onAction: noop, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /sourcePath: D:\/repo/);
    assert.match(buildMcpToolDetailChoice({ tool: tools[0]!, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /inputSchema:/);
  });
});
```

- [ ] **Step 2: Implement menu builders**

Implement builders returning `InteractionChoice` objects. Use these stable behaviors:

```ts
// skillsMenu.ts exports
buildSkillsListChoice({ skills, onSelect, onCancel })
buildSkillsDetailChoice({ skill, onBack, onCancel })

// hooksMenu.ts exports
buildHooksEventChoice({ hooks, onSelect, onCancel })
buildHooksMatcherChoice({ event, hooks, onSelect, onBack, onCancel })
buildHooksHookChoice({ event, matcher, hooks, onSelect, onBack, onCancel })
buildHooksHookDetailChoice({ hook, onBack, onCancel })

// mcpMenu.ts exports
export type McpMenuAction = "enable" | "disable" | "reconnect";
buildMcpListChoice({ servers, onSelect, onAction, onCancel })
buildMcpServerChoice({ server, tools, onSelectTools, onAction, onBack, onCancel })
buildMcpToolsChoice({ server, tools, onSelect, onBack, onCancel })
buildMcpToolDetailChoice({ tool, onBack, onCancel })
```

Each empty list must produce one disabled option with value `__empty__`. Each detail view must use `documentBlock` with `scrollable: true`. `src/tui/commandMenus/index.ts` re-exports all three modules.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/tui/commandMenus.test.ts
```

Expected: exit `0`.

Commit:

```bash
git add src/tui/commandMenus tests/tui/commandMenus.test.ts
git commit -m "feat: add tui command menu builders"
```

---

### Task 5: Wire TUI Commands And MCP Actions

**Files:**
- Modify: `src/tui/TuiApp.tsx:61-84,678-701,1248-1291,2495-2514`
- Modify: `src/tui/launchTui.tsx:38-55`
- Test: `tests/tui/tuiAppCommandMenus.test.tsx`

- [ ] **Step 1: Write failing TUI tests**

Create `tests/tui/tuiAppCommandMenus.test.tsx` with three cases: `/skills` opens menu and Esc logs `Skills dialog dismissed`; `/hooks` opens a menu showing `Stop`; `/mcp disable docs` calls injected `executeMcpActionForTest("disable", "docs")` and logs result.

- [ ] **Step 2: Add TUI state and props**

In `TuiApp.tsx`, add imports from `../mcp/config.js`, `../mcp/configMutations.js`, and `./commandMenus/index.js`. Add:

```ts
type CommandMenuState =
  | { kind: "skills:list" }
  | { kind: "skills:detail"; skillName: string }
  | { kind: "hooks:events" }
  | { kind: "hooks:matchers"; event: string }
  | { kind: "hooks:hooks"; event: string; matcher: string }
  | { kind: "hooks:detail"; id: string }
  | { kind: "mcp:list" }
  | { kind: "mcp:server"; serverName: string }
  | { kind: "mcp:tools"; serverName: string }
  | { kind: "mcp:toolDetail"; serverName: string; toolName: string };

type McpActionResult = { title: string; detail: string };
```

Add props:

```ts
mcpConfigOptions?: McpConfigSourceOptions;
executeMcpActionForTest?: (action: McpMenuAction, serverName?: string) => Promise<McpActionResult>;
```

Add state:

```ts
const [commandMenu, setCommandMenu] = useState<CommandMenuState | undefined>();
```

- [ ] **Step 3: Add command branches**

In the `event.type === "command"` branch:

```ts
if (event.name === "skills") setCommandMenu({ kind: "skills:list" });
if (event.name === "hooks") setCommandMenu({ kind: "hooks:events" });
if (event.name === "mcp") {
  if (event.subcommand) void runMcpAction(event.subcommand, event.serverName);
  else if (event.args.length) setState((current) => ({ ...current, error: "Usage: /mcp [enable|disable|reconnect [server-name]]" }));
  else setCommandMenu({ kind: "mcp:list" });
}
```

`runMcpAction` must reject `/mcp reconnect` without server using `Usage: /mcp reconnect <server-name>`.

- [ ] **Step 4: Implement MCP action flow**

Add `runMcpAction`, `executeMcpRuntimeAction`, and `requiredMcpConfigOptions` near `showDiagnostics`. The real action flow is:

```ts
if (action === "disable") await setMcpServerDisabledState(requiredMcpConfigOptions(), target, true);
if (action === "enable") await setMcpServerDisabledState(requiredMcpConfigOptions(), target, false);
const latest = (await loadMergedMcpServersWithSourceDetails(requiredMcpConfigOptions())).find((server) => server.name === target);
if (!latest) throw new Error(`Unknown MCP server ${target}`);
if (action === "disable") await mcpRuntime.disconnect(target, "disabled");
if (action === "enable") await mcpRuntime.reconnect(latest);
if (action === "reconnect") {
  if (latest.disabled) throw new Error(`MCP server ${target} is disabled; enable it first`);
  await mcpRuntime.reconnect(latest);
}
```

For batch enable/disable, targets are all current `collectDiagnostics()?.mcp` names. Track `succeeded` and `failed`; if every target fails, surface an error; otherwise log a status detail containing both lists.

- [ ] **Step 5: Prefer command menu choice in render**

Before existing `buildActiveChoice`, compute a `commandMenuChoice` from current diagnostics. The helper `buildCommandMenuChoice` must route state to the pure builders from Task 4 and use these close messages: `Skills dialog dismissed`, `Hooks dialog dismissed`, `MCP dialog dismissed`.

- [ ] **Step 6: Update help and launch**

In `helpDetailText()`, add:

```ts
"  /skills list available skills",
"  /hooks view hook configurations",
"  /mcp manage MCP servers",
"  /mcp enable|disable [server-name] toggle MCP servers",
"  /mcp reconnect <server-name> reconnect an MCP server",
```

In `launchTui.tsx`, load MCP through `loadMergedMcpServersWithSourceDetails` and pass:

```ts
const mcpConfigOptions = { cwd: options.cwd, agentTeamPath: configPath, agentTeamServers: config.mcpServers };
```

to both loading and `<TuiApp mcpConfigOptions={mcpConfigOptions} />`.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm run build:test
node scripts/run-tests.mjs tests/tui/tuiAppCommandMenus.test.tsx tests/tui/commandMenus.test.ts
```

Expected: exit `0`.

Commit:

```bash
git add src/tui/TuiApp.tsx src/tui/launchTui.tsx tests/tui/tuiAppCommandMenus.test.tsx
git commit -m "feat: wire tui command menus"
```

---

### Task 6: Final Verification

**Files:**
- Review all files listed in the File Map.

- [ ] **Step 1: Run focused suite**

```bash
npm run build:test
node scripts/run-tests.mjs tests/commands/registry.test.ts tests/tui/commandCompletion.test.ts tests/mcp/config.test.ts tests/mcp/connectionManager.test.ts tests/diagnostics/runtimeDiagnostics.test.ts tests/tui/commandMenus.test.ts tests/tui/tuiAppCommandMenus.test.tsx
```

Expected: exit `0`.

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: exit `0`.

- [ ] **Step 3: Scope review**

```bash
git diff --stat HEAD
git diff -- src/commands/registry.ts src/tui/commandCompletion.ts src/mcp/schema.ts src/mcp/config.ts src/mcp/configMutations.ts src/mcp/runtime.ts src/tui/commandMenus src/tui/TuiApp.tsx src/tui/launchTui.tsx tests
```

Expected: diff contains no plugin, OAuth/auth flow, `claudeai-proxy`, or unrelated agent changes.

- [ ] **Step 4: Commit final fixes if any**

```bash
git add src tests
git commit -m "test: verify tui command alignment"
```

Skip this commit when Step 1 through Step 3 produced no changes.

---

## Self-Review

**Spec coverage:** Task 1 covers command registry and completion. Task 2 covers effective-source config writeback. Task 3 covers immediate runtime state changes. Task 4 covers `/skills`, `/hooks`, and `/mcp` menu data. Task 5 wires TUI behavior and transcript messages. Task 6 verifies exclusions and regressions.

**Placeholder scan:** No forbidden placeholder patterns or intentionally blank implementation sections were found.

**Type consistency:** `McpConfigSourceOptions` lives in `src/mcp/config.ts`; `McpMenuAction` lives in `src/tui/commandMenus/mcpMenu.ts`; `McpRuntimeDiagnostic` and `McpToolDiagnostic` live in `src/mcp/runtime.ts`; `CommandMenuState` remains local to `TuiApp.tsx`.

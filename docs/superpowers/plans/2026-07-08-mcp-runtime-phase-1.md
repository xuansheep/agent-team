# MCP Runtime Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase-one MCP support for stdio, streamable HTTP, SSE, and WebSocket servers with tools, resources, prompts, and deferred tool discovery.

**Architecture:** Add an MCP runtime layer that reads merged MCP server config, owns connection lifecycle, caches server capabilities, and exposes stable local tools. Keep MCP protocol details behind `McpRuntime` and adapters so the existing `ToolRegistry`, `KernelToolRegistry`, `RuntimeTurnExecutor`, and `QueryEngine` remain the integration boundary.

**Tech Stack:** TypeScript, Node.js, zod, js-yaml, undici, existing agent-team tool registry, MCP SDK or local transport adapters where SDK support is unavailable.

---

## Scope

This plan implements only Phase 0 and Phase 1 from `docs/superpowers/specs/2026-07-08-mcp-skill-hook-alignment-design.md`.

Included:

- user settings path migration to `~/.einsteins/settings.yaml`
- MCP config from `~/.einsteins/mcp.json`, project `.mcp.json`, and `agent-team.yaml mcpServers`
- precedence: `agent-team.yaml` > project `.mcp.json` > user `~/.einsteins/mcp.json`
- transports: `stdio`, `http`, `sse`, `ws`
- MCP tools, resources, prompts
- `ToolSearch` plus deferred MCP tools
- `ListMcpResources`, `ReadMcpResource`, `ListMcpPrompts`, `GetMcpPrompt`, `RunMcpPrompt`

Excluded:

- claudeai-proxy
- OAuth or authentication
- MCP skills
- plugin skills
- plugin hooks
- registering MCP prompts as slash commands

## File Structure

Create:

- `src/mcp/schema.ts` - zod schemas and normalized MCP server config types.
- `src/mcp/config.ts` - load and merge MCP config sources.
- `src/mcp/transports.ts` - transport factory for stdio, HTTP, SSE, and WebSocket.
- `src/mcp/connectionManager.ts` - server lifecycle, capability cache, and invocation dispatch.
- `src/mcp/runtime.ts` - facade used by local tools and future TUI diagnostics.
- `src/mcp/deferredTools.ts` - ToolSearch and deferred MCP tool adapters.
- `src/mcp/resourceTools.ts` - resource listing and reading tools.
- `src/mcp/promptTools.ts` - prompt listing, fetching, and execution tools.
- `tests/mcp/config.test.ts` - config loading and precedence.
- `tests/mcp/connectionManager.test.ts` - fake client lifecycle and cache tests.
- `tests/mcp/deferredTools.test.ts` - deferred tool search and invocation.
- `tests/mcp/resourceTools.test.ts` - resource tools.
- `tests/mcp/promptTools.test.ts` - prompt tools.

Modify:

- `src/config/schema.ts` - add optional `mcpServers` to `agent-team.yaml`.
- `src/config/loadConfig.ts` - preserve parsed MCP server config in resolved config.
- `src/settings/loadSettings.ts` - use `~/.einsteins/settings.yaml` with legacy fallback.
- `src/tools/registry.ts` - register MCP discovery/resource/prompt tools when an MCP runtime is provided.
- `src/runtime/types.ts` - optionally carry `mcpRuntime`.
- `src/kernel/session.ts` or caller construction site - pass MCP runtime into tool registry creation.
- `tests/config/loadConfig.test.ts` - `agent-team.yaml mcpServers` parsing.
- `tests/settings/settings.test.ts` - settings path behavior.
- `package.json` and `package-lock.json` - add MCP SDK dependency only if local SDK is not already available.

Do not modify Skill or Hook runtime files in this plan.

## Task 1: Add MCP Config Schema

**Files:**

- Create: `src/mcp/schema.ts`
- Modify: `src/config/schema.ts`
- Test: `tests/mcp/config.test.ts`
- Test: `tests/config/loadConfig.test.ts`

- [ ] **Step 1: Write failing tests for MCP server schema**

Add `tests/mcp/config.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mcpServersSchema } from "../../src/mcp/schema.js";

describe("MCP config schema", () => {
  it("accepts stdio, http, sse, and ws servers", () => {
    const parsed = mcpServersSchema.parse({
      local: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: { NODE_ENV: "test" },
        cwd: ".",
        timeoutMs: 3000
      },
      docs: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { "x-client": "agent-team" }
      },
      events: {
        type: "sse",
        url: "https://mcp.example.test/sse"
      },
      socket: {
        type: "ws",
        url: "wss://mcp.example.test/ws",
        disabled: true
      }
    });

    assert.equal(parsed.local.type, "stdio");
    assert.equal(parsed.docs.type, "http");
    assert.equal(parsed.events.type, "sse");
    assert.equal(parsed.socket.disabled, true);
  });

  it("rejects authentication-only config fields", () => {
    assert.throws(() => mcpServersSchema.parse({
      secure: {
        type: "http",
        url: "https://mcp.example.test",
        oauth: { clientId: "x" }
      }
    }), /Unrecognized key|Invalid/);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/config.test.js
```

Expected: TypeScript fails because `src/mcp/schema.ts` does not exist.

- [ ] **Step 3: Implement `src/mcp/schema.ts`**

Create:

```ts
import { z } from "zod";

const commonServerFields = {
  disabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
};

export const stdioMcpServerSchema = z.object({
  ...commonServerFields,
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().min(1).optional()
}).strict();

export const remoteMcpServerSchema = z.object({
  ...commonServerFields,
  type: z.enum(["http", "sse", "ws"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional()
}).strict();

export const mcpServerSchema = z.discriminatedUnion("type", [
  stdioMcpServerSchema,
  remoteMcpServerSchema
]);

export const mcpServersSchema = z.record(mcpServerSchema);

export type StdioMcpServerConfig = z.infer<typeof stdioMcpServerSchema>;
export type RemoteMcpServerConfig = z.infer<typeof remoteMcpServerSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServersConfig = z.infer<typeof mcpServersSchema>;

export type ResolvedMcpServerConfig = McpServerConfig & {
  name: string;
  source: "user" | "project" | "agent-team";
};
```

- [ ] **Step 4: Add `mcpServers` to `agent-team.yaml` schema**

Modify `src/config/schema.ts` by importing `mcpServersSchema` and adding an optional field to the top-level config schema:

```ts
import { mcpServersSchema } from "../mcp/schema.js";
```

Add to the top-level object:

```ts
mcpServers: mcpServersSchema.optional()
```

Keep the schema strict so unknown auth fields still fail.

- [ ] **Step 5: Add config parsing test**

Append to `tests/config/loadConfig.test.ts`:

```ts
it("parses mcpServers from agent-team.yaml", async () => {
  const cwd = await workspace();
  const configPath = join(cwd, "agent-team.yaml");
  await writeText(configPath, `
providers:
  default:
    type: openai-compatible
    base_url: https://api.example.test/v1
    api_key_env: TEST_API_KEY
    default_model: default-model
mcpServers:
  local:
    type: stdio
    command: node
    args:
      - server.mjs
roles:
  dev:
    system_prompt: Build safely.
workflows:
  delivery:
    nodes:
      - id: dev
        role: dev
        provider: default
    edges: []
`);

  const config = await loadConfig(configPath, { cwd });

  assert.equal(config.mcpServers?.local?.type, "stdio");
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/config.test.js dist-test/tests/config/loadConfig.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/schema.ts src/config/schema.ts tests/mcp/config.test.ts tests/config/loadConfig.test.ts
git commit -m "feat: add MCP server config schema"
```

## Task 2: Implement MCP Config Source Loading and Precedence

**Files:**

- Create: `src/mcp/config.ts`
- Modify: `src/settings/loadSettings.ts`
- Test: `tests/mcp/config.test.ts`
- Test: `tests/settings/settings.test.ts`

- [ ] **Step 1: Add failing tests for config source precedence**

Append to `tests/mcp/config.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMcpConfigSources, mergeMcpServers } from "../../src/mcp/config.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-mcp-config-"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

it("merges MCP servers with agent-team precedence over project and user", async () => {
  const cwd = await tempWorkspace();
  const userPath = join(cwd, "user-mcp.json");
  const projectPath = join(cwd, ".mcp.json");
  await writeJson(userPath, {
    mcpServers: {
      shared: { type: "stdio", command: "user" },
      userOnly: { type: "stdio", command: "user-only" }
    }
  });
  await writeJson(projectPath, {
    mcpServers: {
      shared: { type: "stdio", command: "project" },
      projectOnly: { type: "http", url: "https://project.example.test" }
    }
  });

  const merged = mergeMcpServers({
    user: { shared: { type: "stdio", command: "user" }, userOnly: { type: "stdio", command: "user-only" } },
    project: { shared: { type: "stdio", command: "project" }, projectOnly: { type: "http", url: "https://project.example.test" } },
    agentTeam: { shared: { type: "stdio", command: "agent" }, agentOnly: { type: "sse", url: "https://agent.example.test/sse" } }
  });

  assert.equal(merged.find((server) => server.name === "shared")?.source, "agent-team");
  assert.equal((merged.find((server) => server.name === "shared") as { command?: string }).command, "agent");
  assert.equal(merged.find((server) => server.name === "projectOnly")?.source, "project");
  assert.equal(merged.find((server) => server.name === "userOnly")?.source, "user");
});

it("loads user and project MCP json files", async () => {
  const cwd = await tempWorkspace();
  const userPath = join(cwd, "mcp.json");
  const projectPath = join(cwd, ".mcp.json");
  await writeJson(userPath, { mcpServers: { userServer: { type: "stdio", command: "user" } } });
  await writeJson(projectPath, { mcpServers: { projectServer: { type: "http", url: "https://project.example.test" } } });

  const sources = await loadMcpConfigSources({ cwd, userMcpPath: userPath, projectMcpPath: projectPath });

  assert.equal(sources.user?.userServer?.type, "stdio");
  assert.equal(sources.project?.projectServer?.type, "http");
});
```

- [ ] **Step 2: Add failing settings path test**

Append to `tests/settings/settings.test.ts`:

```ts
it("defaults user settings to ~/.einsteins and exposes the legacy fallback path", () => {
  assert.match(defaultUserSettingsPath(), /[\\/]\\.einsteins[\\/]settings\\.yaml$/);
  assert.match(legacyUserSettingsPath(), /[\\/]\\.agent-team[\\/]settings\\.yaml$/);
});
```

Also update the imports:

```ts
import { defaultUserSettingsPath, legacyUserSettingsPath, loadSettings } from "../../src/settings/loadSettings.js";
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/config.test.js dist-test/tests/settings/settings.test.js
```

Expected: build fails because `src/mcp/config.ts`, `defaultUserSettingsPath`, or `legacyUserSettingsPath` are missing.

- [ ] **Step 4: Implement MCP config loader**

Create `src/mcp/config.ts`:

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mcpServersSchema, type McpServersConfig, type ResolvedMcpServerConfig } from "./schema.js";

const mcpJsonSchema = z.object({
  mcpServers: mcpServersSchema.optional()
}).strict();

export type McpConfigSourceOptions = {
  cwd: string;
  userMcpPath?: string;
  projectMcpPath?: string;
  agentTeamServers?: McpServersConfig;
};

export type McpConfigSources = {
  user?: McpServersConfig;
  project?: McpServersConfig;
  agentTeam?: McpServersConfig;
};

export async function loadMcpConfigSources(options: McpConfigSourceOptions): Promise<McpConfigSources> {
  return {
    user: await readMcpJson(options.userMcpPath ?? defaultUserMcpPath()),
    project: await readMcpJson(options.projectMcpPath ?? defaultProjectMcpPath(options.cwd)),
    agentTeam: options.agentTeamServers
  };
}

export function mergeMcpServers(sources: McpConfigSources): ResolvedMcpServerConfig[] {
  const merged = new Map<string, ResolvedMcpServerConfig>();
  addServers(merged, "user", sources.user);
  addServers(merged, "project", sources.project);
  addServers(merged, "agent-team", sources.agentTeam);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadMergedMcpServers(options: McpConfigSourceOptions): Promise<ResolvedMcpServerConfig[]> {
  return mergeMcpServers(await loadMcpConfigSources(options));
}

export function defaultUserMcpPath(): string {
  return join(homedir(), ".einsteins", "mcp.json");
}

function defaultProjectMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

async function readMcpJson(path: string): Promise<McpServersConfig | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return mcpJsonSchema.parse(JSON.parse(raw)).mcpServers;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function addServers(
  target: Map<string, ResolvedMcpServerConfig>,
  source: ResolvedMcpServerConfig["source"],
  servers: McpServersConfig | undefined
): void {
  for (const [name, config] of Object.entries(servers ?? {})) {
    target.set(name, { ...config, name, source });
  }
}
```

- [ ] **Step 5: Update settings path exports**

Modify `src/settings/loadSettings.ts`:

```ts
export function defaultUserSettingsPath(): string {
  return join(homedir(), ".einsteins", "settings.yaml");
}

export function legacyUserSettingsPath(): string {
  return join(homedir(), ".agent-team", "settings.yaml");
}
```

Change user settings loading:

```ts
const userSettings = await readSettingsFile(
  options.userSettingsPath ?? defaultUserSettingsPath(),
  legacyUserSettingsPath()
);
```

Change `readSettingsFile` signature:

```ts
async function readSettingsFile(path: string, fallbackPath?: string): Promise<AgentTeamSettings | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return settingsSchema.parse(yaml.load(raw) ?? {});
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    if (!fallbackPath) return undefined;
    return readSettingsFile(fallbackPath);
  }
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/config.test.js dist-test/tests/settings/settings.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/config.ts src/settings/loadSettings.ts tests/mcp/config.test.ts tests/settings/settings.test.ts
git commit -m "feat: merge MCP config sources"
```

## Task 3: Define MCP Runtime Interfaces and Fake Client

**Files:**

- Modify: `src/mcp/types.ts`
- Create: `src/mcp/runtime.ts`
- Test: `tests/mcp/connectionManager.test.ts`

- [ ] **Step 1: Write failing runtime facade tests**

Create `tests/mcp/connectionManager.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpClient, McpTool } from "../../src/mcp/types.js";

class FakeMcpClient implements McpClient {
  constructor(private readonly tools: McpTool[] = []) {}

  async listTools(): Promise<McpTool[]> {
    return this.tools;
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    return { name, input };
  }

  async listResources() {
    return [{ uri: "file://readme", name: "Readme", mimeType: "text/plain" }];
  }

  async readResource(uri: string) {
    return { uri, contents: [{ type: "text", text: "hello", mimeType: "text/plain" }] };
  }

  async listPrompts() {
    return [{ name: "explain", description: "Explain code", arguments: [] }];
  }

  async getPrompt(name: string, args: Record<string, unknown>) {
    return { name, messages: [{ role: "user", content: `prompt ${args.topic}` }] };
  }
}

describe("McpRuntime", () => {
  it("connects servers and caches tools, resources, and prompts", async () => {
    const runtime = new McpRuntime({
      clientFactory: async () => new FakeMcpClient([{ name: "search", description: "Search", inputSchema: { type: "object" } }])
    });

    await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);

    assert.equal(runtime.getServerStatus("docs")?.state, "connected");
    assert.equal(runtime.listTools()[0]?.name, "mcp__docs__search");
    assert.equal((await runtime.listResources({ server: "docs" }))[0]?.uri, "file://readme");
    assert.equal((await runtime.listPrompts({ server: "docs" }))[0]?.name, "explain");
  });

  it("marks only the failing server as failed", async () => {
    const runtime = new McpRuntime({
      clientFactory: async (server) => {
        if (server.name === "bad") throw new Error("boom");
        return new FakeMcpClient();
      }
    });

    await runtime.connectAll([
      { name: "ok", source: "project", type: "http", url: "https://ok.example.test" },
      { name: "bad", source: "project", type: "http", url: "https://bad.example.test" }
    ]);

    assert.equal(runtime.getServerStatus("ok")?.state, "connected");
    assert.equal(runtime.getServerStatus("bad")?.state, "failed");
  });
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: build fails because `McpRuntime` and expanded `McpClient` are missing.

- [ ] **Step 3: Expand MCP protocol types**

Modify `src/mcp/types.ts`:

```ts
export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent =
  | { type: "text"; text: string; mimeType?: string }
  | { type: "blob"; blob: string; mimeType?: string };

export type McpPrompt = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpPromptMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type McpClient = {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<{ uri: string; contents: McpResourceContent[] }>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args: Record<string, unknown>): Promise<{ name: string; messages: McpPromptMessage[] }>;
  close?(): Promise<void>;
};
```

- [ ] **Step 4: Implement `McpRuntime` facade**

Create `src/mcp/runtime.ts`:

```ts
import type { ResolvedMcpServerConfig } from "./schema.js";
import type { McpClient, McpPrompt, McpResource, McpTool } from "./types.js";

export type McpServerState = "pending" | "connected" | "failed" | "disabled";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  error?: string;
};

export type RuntimeMcpTool = McpTool & {
  server: string;
  name: string;
  originalName: string;
};

export type McpRuntimeOptions = {
  clientFactory(server: ResolvedMcpServerConfig): Promise<McpClient>;
};

type ServerRecord = {
  config: ResolvedMcpServerConfig;
  status: McpServerStatus;
  client?: McpClient;
  tools: RuntimeMcpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
};

export class McpRuntime {
  private readonly servers = new Map<string, ServerRecord>();

  constructor(private readonly options: McpRuntimeOptions) {}

  async connectAll(configs: ResolvedMcpServerConfig[]): Promise<void> {
    await Promise.all(configs.map((config) => this.connect(config)));
  }

  async connect(config: ResolvedMcpServerConfig): Promise<void> {
    const record: ServerRecord = {
      config,
      status: { name: config.name, state: config.disabled ? "disabled" : "pending" },
      tools: [],
      resources: [],
      prompts: []
    };
    this.servers.set(config.name, record);
    if (config.disabled) return;

    try {
      const client = await this.options.clientFactory(config);
      record.client = client;
      record.tools = (await client.listTools()).map((tool) => ({
        ...tool,
        server: config.name,
        originalName: tool.name,
        name: mcpToolName(config.name, tool.name)
      }));
      record.resources = await client.listResources();
      record.prompts = await client.listPrompts();
      record.status = { name: config.name, state: "connected" };
    } catch (error) {
      record.status = { name: config.name, state: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  getServerStatus(name: string): McpServerStatus | undefined {
    return this.servers.get(name)?.status;
  }

  listServerStatuses(): McpServerStatus[] {
    return [...this.servers.values()].map((record) => record.status);
  }

  listTools(): RuntimeMcpTool[] {
    return [...this.servers.values()].flatMap((record) => record.tools);
  }

  async callTool(server: string, tool: string, input: unknown): Promise<unknown> {
    const record = this.requireConnectedServer(server);
    return record.client.callTool(tool, input);
  }

  async listResources(input: { server?: string } = {}): Promise<Array<McpResource & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) =>
      record.resources.map((resource) => ({ ...resource, server: record.config.name }))
    );
  }

  async readResource(server: string, uri: string): Promise<unknown> {
    return this.requireConnectedServer(server).client.readResource(uri);
  }

  async listPrompts(input: { server?: string } = {}): Promise<Array<McpPrompt & { server: string }>> {
    return this.matchingRecords(input.server).flatMap((record) =>
      record.prompts.map((prompt) => ({ ...prompt, server: record.config.name }))
    );
  }

  async getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.requireConnectedServer(server).client.getPrompt(name, args);
  }

  private matchingRecords(server?: string): ServerRecord[] {
    if (server) return [this.requireConnectedServer(server)];
    return [...this.servers.values()].filter((record) => record.status.state === "connected" && record.client);
  }

  private requireConnectedServer(server: string): ServerRecord & { client: McpClient } {
    const record = this.servers.get(server);
    if (!record) throw new Error(`Unknown MCP server ${server}`);
    if (record.status.state !== "connected" || !record.client) throw new Error(`MCP server ${server} is not connected`);
    return record as ServerRecord & { client: McpClient };
  }
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/types.ts src/mcp/runtime.ts tests/mcp/connectionManager.test.ts
git commit -m "feat: add MCP runtime facade"
```

## Task 4: Add Transport Factory

**Files:**

- Create: `src/mcp/transports.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/mcp/connectionManager.test.ts`

- [ ] **Step 1: Add failing transport factory tests**

Append to `tests/mcp/connectionManager.test.ts`:

```ts
import { createMcpClientFactory } from "../../src/mcp/transports.js";

it("creates a client factory for every phase-one transport type", async () => {
  const created: string[] = [];
  const factory = createMcpClientFactory({
    createClient: async (server) => {
      created.push(server.type);
      return new FakeMcpClient();
    }
  });

  await factory({ name: "stdio", source: "project", type: "stdio", command: "node" });
  await factory({ name: "http", source: "project", type: "http", url: "https://mcp.example.test" });
  await factory({ name: "sse", source: "project", type: "sse", url: "https://mcp.example.test/sse" });
  await factory({ name: "ws", source: "project", type: "ws", url: "wss://mcp.example.test/ws" });

  assert.deepEqual(created, ["stdio", "http", "sse", "ws"]);
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: build fails because `src/mcp/transports.ts` does not exist.

- [ ] **Step 3: Add SDK dependency if needed**

If no MCP SDK dependency is already present, run:

```bash
npm install @modelcontextprotocol/sdk
```

Expected: `package.json` and `package-lock.json` include `@modelcontextprotocol/sdk`.

If the environment cannot access the network, record the failure and implement the local factory seam in Step 4 so fake tests can pass. Do not create a custom package cache or repository.

- [ ] **Step 4: Implement transport factory seam**

Create `src/mcp/transports.ts`:

```ts
import type { ResolvedMcpServerConfig } from "./schema.js";
import type { McpClient } from "./types.js";

export type McpClientFactory = (server: ResolvedMcpServerConfig) => Promise<McpClient>;

export type McpTransportFactoryOptions = {
  createClient?: McpClientFactory;
};

export function createMcpClientFactory(options: McpTransportFactoryOptions = {}): McpClientFactory {
  if (options.createClient) return options.createClient;
  return async (server) => {
    switch (server.type) {
      case "stdio":
        return createStdioClient(server);
      case "http":
        return createHttpClient(server);
      case "sse":
        return createSseClient(server);
      case "ws":
        return createWebSocketClient(server);
    }
  };
}

async function createStdioClient(server: Extract<ResolvedMcpServerConfig, { type: "stdio" }>): Promise<McpClient> {
  throw new Error(`stdio MCP transport is not wired yet for ${server.name}`);
}

async function createHttpClient(server: Extract<ResolvedMcpServerConfig, { type: "http" }>): Promise<McpClient> {
  throw new Error(`http MCP transport is not wired yet for ${server.name}`);
}

async function createSseClient(server: Extract<ResolvedMcpServerConfig, { type: "sse" }>): Promise<McpClient> {
  throw new Error(`sse MCP transport is not wired yet for ${server.name}`);
}

async function createWebSocketClient(server: Extract<ResolvedMcpServerConfig, { type: "ws" }>): Promise<McpClient> {
  throw new Error(`ws MCP transport is not wired yet for ${server.name}`);
}
```

This seam allows later SDK-specific implementation without leaking transport details into runtime tests.

- [ ] **Step 5: Wire real SDK transports**

Replace the four throwing functions with SDK-backed clients. Keep the return value typed as local `McpClient`.

Implementation pattern:

```ts
type SdkClientLike = {
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(input: { name: string; arguments?: unknown }): Promise<unknown>;
  listResources(): Promise<{ resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> }>;
  readResource(input: { uri: string }): Promise<unknown>;
  listPrompts(): Promise<{ prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> }>;
  getPrompt(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close?(): Promise<void>;
};

function adaptSdkClient(client: SdkClientLike): McpClient {
  return {
    async listTools() {
      return (await client.listTools()).tools ?? [];
    },
    async callTool(name, input) {
      return client.callTool({ name, arguments: input });
    },
    async listResources() {
      return (await client.listResources()).resources ?? [];
    },
    async readResource(uri) {
      return client.readResource({ uri });
    },
    async listPrompts() {
      return (await client.listPrompts()).prompts ?? [];
    },
    async getPrompt(name, args) {
      return client.getPrompt({ name, arguments: args });
    },
    close: () => client.close?.() ?? Promise.resolve()
  };
}
```

Use SDK imports that match the installed SDK version. If the SDK lacks a WebSocket transport, implement the WebSocket branch through a small adapter that speaks the MCP JSON-RPC message shape and still returns `McpClient`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: fake factory tests pass. Real transport integration can be covered with separate opt-in tests after environment setup.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/transports.ts package.json package-lock.json tests/mcp/connectionManager.test.ts
git commit -m "feat: add MCP transport factory"
```

## Task 5: Add Deferred MCP Tool Search and Invocation

**Files:**

- Create: `src/mcp/deferredTools.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/mcp/deferredTools.test.ts`

- [ ] **Step 1: Write failing deferred tool tests**

Create `tests/mcp/deferredTools.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolSearchTool, createDeferredMcpTool } from "../../src/mcp/deferredTools.js";
import type { RuntimeMcpTool } from "../../src/mcp/runtime.js";

const tools: RuntimeMcpTool[] = [
  { server: "docs", originalName: "search", name: "mcp__docs__search", description: "Search docs", inputSchema: { type: "object" } },
  { server: "repo", originalName: "findFile", name: "mcp__repo__findFile", description: "Find files", inputSchema: { type: "object" } }
];

describe("deferred MCP tools", () => {
  it("searches MCP tools by name and description", async () => {
    const tool = createMcpToolSearchTool({ listTools: () => tools });

    const result = await tool.execute({ query: "docs" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /mcp__docs__search/);
    assert.doesNotMatch(result.output ?? "", /mcp__repo__findFile/);
  });

  it("invokes a deferred MCP tool through runtime", async () => {
    const called: unknown[] = [];
    const tool = createDeferredMcpTool(tools[0], {
      callTool: async (server, originalName, input) => {
        called.push({ server, originalName, input });
        return { ok: true };
      }
    });

    const result = await tool.execute({ q: "abc" }, { cwd: process.cwd() });

    assert.deepEqual(called, [{ server: "docs", originalName: "search", input: { q: "abc" } }]);
    assert.deepEqual(result.data, { ok: true });
  });
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/deferredTools.test.js
```

Expected: build fails because `src/mcp/deferredTools.ts` does not exist.

- [ ] **Step 3: Implement deferred MCP tools**

Create `src/mcp/deferredTools.ts`:

```ts
import type { Tool } from "../tools/types.js";
import type { RuntimeMcpTool } from "./runtime.js";

export type McpToolSearchRuntime = {
  listTools(): RuntimeMcpTool[];
};

export type DeferredMcpToolRuntime = {
  callTool(server: string, originalName: string, input: unknown): Promise<unknown>;
};

export function createMcpToolSearchTool(runtime: McpToolSearchRuntime): Tool {
  return {
    name: "ToolSearch",
    description: "Search available local and MCP tools by query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const query = objectInput(input).query.toLowerCase();
      const matches = runtime.listTools().filter((tool) =>
        tool.name.toLowerCase().includes(query) ||
        tool.originalName.toLowerCase().includes(query) ||
        (tool.description ?? "").toLowerCase().includes(query)
      );
      return {
        output: matches.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n"),
        data: matches
      };
    }
  };
}

export function createDeferredMcpTool(tool: RuntimeMcpTool, runtime: DeferredMcpToolRuntime): Tool {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool ${tool.originalName} from ${tool.server}`,
    input_schema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    async execute(input) {
      const data = await runtime.callTool(tool.server, tool.originalName, input ?? {});
      return {
        output: typeof data === "string" ? data : JSON.stringify(data),
        data
      };
    },
    mapToolResultToModelResult(result) {
      return result.data ?? result.output ?? result.error;
    }
  };
}

function objectInput(input: unknown): { query: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ToolSearch input must be an object");
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "string" || !query.trim()) throw new Error("ToolSearch query is required");
  return { query };
}
```

- [ ] **Step 4: Add registry integration seam**

Modify `src/tools/registry.ts`:

```ts
import type { McpRuntime } from "../mcp/runtime.js";
import { createDeferredMcpTool, createMcpToolSearchTool } from "../mcp/deferredTools.js";
```

Change factory signature:

```ts
export function createLocalToolRegistry(options: { mcpRuntime?: McpRuntime } = {}): ToolRegistry {
```

After local tools are added:

```ts
if (options.mcpRuntime) {
  registry.add(createMcpToolSearchTool(options.mcpRuntime));
  for (const tool of options.mcpRuntime.listTools()) {
    registry.add(createDeferredMcpTool(tool, options.mcpRuntime));
  }
}
```

Keep the no-argument call behavior unchanged.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/deferredTools.test.js tests/tools/localTools.test.js
```

Expected: all focused tests pass. If `tests/tools/localTools.test.js` is not present in `dist-test`, use `dist-test/tests/tools/localTools.test.js`.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/deferredTools.ts src/tools/registry.ts tests/mcp/deferredTools.test.ts
git commit -m "feat: add deferred MCP tools"
```

## Task 6: Add MCP Resource Tools

**Files:**

- Create: `src/mcp/resourceTools.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/mcp/resourceTools.test.ts`

- [ ] **Step 1: Write failing resource tool tests**

Create `tests/mcp/resourceTools.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createListMcpResourcesTool, createReadMcpResourceTool } from "../../src/mcp/resourceTools.js";

describe("MCP resource tools", () => {
  it("lists resources", async () => {
    const tool = createListMcpResourcesTool({
      listResources: async () => [{ server: "docs", uri: "file://readme", name: "Readme", mimeType: "text/plain" }]
    });

    const result = await tool.execute({ server: "docs" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /file:\/\/readme/);
  });

  it("reads text resources", async () => {
    const tool = createReadMcpResourceTool({
      readResource: async () => ({ uri: "file://readme", contents: [{ type: "text", text: "hello", mimeType: "text/plain" }] })
    });

    const result = await tool.execute({ server: "docs", uri: "file://readme" }, { cwd: process.cwd() });

    assert.equal(result.output, "hello");
  });
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/resourceTools.test.js
```

Expected: build fails because `src/mcp/resourceTools.ts` does not exist.

- [ ] **Step 3: Implement resource tools**

Create `src/mcp/resourceTools.ts`:

```ts
import type { Tool } from "../tools/types.js";

type ResourceRuntime = {
  listResources(input?: { server?: string }): Promise<Array<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }>>;
  readResource(server: string, uri: string): Promise<unknown>;
};

export function createListMcpResourcesTool(runtime: Pick<ResourceRuntime, "listResources">): Tool {
  return {
    name: "ListMcpResources",
    description: "List MCP resources by optional server.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" }
      },
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const server = optionalString(input, "server");
      const resources = await runtime.listResources({ server });
      return {
        output: resources.map((resource) => `${resource.server} ${resource.uri} ${resource.name ?? ""}`).join("\n"),
        data: resources
      };
    }
  };
}

export function createReadMcpResourceTool(runtime: Pick<ResourceRuntime, "readResource">): Tool {
  return {
    name: "ReadMcpResource",
    description: "Read a text MCP resource by server and uri.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" }
      },
      required: ["server", "uri"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input) {
      const value = requiredObject(input);
      const server = requiredString(value, "server");
      const uri = requiredString(value, "uri");
      const resource = await runtime.readResource(server, uri) as { contents?: Array<{ type?: string; text?: string; mimeType?: string }> };
      const text = resource.contents?.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      if (!text) return { error: `MCP resource ${uri} did not contain readable text`, data: resource };
      return { output: text, data: resource };
    }
  };
}

function optionalString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}
```

- [ ] **Step 4: Register resource tools**

Modify `src/tools/registry.ts`:

```ts
import { createListMcpResourcesTool, createReadMcpResourceTool } from "../mcp/resourceTools.js";
```

Inside `if (options.mcpRuntime)`:

```ts
registry.add(createListMcpResourcesTool(options.mcpRuntime));
registry.add(createReadMcpResourceTool(options.mcpRuntime));
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/resourceTools.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/resourceTools.ts src/tools/registry.ts tests/mcp/resourceTools.test.ts
git commit -m "feat: add MCP resource tools"
```

## Task 7: Add MCP Prompt Tools

**Files:**

- Create: `src/mcp/promptTools.ts`
- Modify: `src/tools/registry.ts`
- Test: `tests/mcp/promptTools.test.ts`

- [ ] **Step 1: Write failing prompt tool tests**

Create `tests/mcp/promptTools.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGetMcpPromptTool, createListMcpPromptsTool, createRunMcpPromptTool } from "../../src/mcp/promptTools.js";

describe("MCP prompt tools", () => {
  it("lists prompts", async () => {
    const tool = createListMcpPromptsTool({
      listPrompts: async () => [{ server: "docs", name: "explain", description: "Explain code", arguments: [] }]
    });

    const result = await tool.execute({ server: "docs" }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /docs explain/);
  });

  it("gets prompt metadata", async () => {
    const tool = createGetMcpPromptTool({
      listPrompts: async () => [{ server: "docs", name: "explain", description: "Explain code", arguments: [{ name: "topic", required: true }] }]
    });

    const result = await tool.execute({ server: "docs", name: "explain" }, { cwd: process.cwd() });

    assert.deepEqual((result.data as { name: string }).name, "explain");
  });

  it("runs a prompt", async () => {
    const tool = createRunMcpPromptTool({
      getPrompt: async (_server, name, args) => ({ name, messages: [{ role: "user", content: `explain ${args.topic}` }] })
    });

    const result = await tool.execute({ server: "docs", name: "explain", arguments: { topic: "MCP" } }, { cwd: process.cwd() });

    assert.match(result.output ?? "", /explain MCP/);
  });
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/promptTools.test.js
```

Expected: build fails because `src/mcp/promptTools.ts` does not exist.

- [ ] **Step 3: Implement prompt tools**

Create `src/mcp/promptTools.ts`:

```ts
import type { Tool } from "../tools/types.js";

type PromptRuntime = {
  listPrompts(input?: { server?: string }): Promise<Array<{ server: string; name: string; description?: string; arguments?: unknown[] }>>;
  getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<unknown>;
};

export function createListMcpPromptsTool(runtime: Pick<PromptRuntime, "listPrompts">): Tool {
  return {
    name: "ListMcpPrompts",
    description: "List MCP prompts by optional server.",
    input_schema: {
      type: "object",
      properties: { server: { type: "string" } },
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const prompts = await runtime.listPrompts({ server: optionalString(input, "server") });
      return {
        output: prompts.map((prompt) => `${prompt.server} ${prompt.name}: ${prompt.description ?? ""}`).join("\n"),
        data: prompts
      };
    }
  };
}

export function createGetMcpPromptTool(runtime: Pick<PromptRuntime, "listPrompts">): Tool {
  return {
    name: "GetMcpPrompt",
    description: "Get MCP prompt metadata.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        name: { type: "string" }
      },
      required: ["server", "name"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input) {
      const value = requiredObject(input);
      const server = requiredString(value, "server");
      const name = requiredString(value, "name");
      const prompt = (await runtime.listPrompts({ server })).find((item) => item.name === name);
      if (!prompt) return { error: `Unknown MCP prompt ${server}/${name}` };
      return { output: JSON.stringify(prompt), data: prompt };
    }
  };
}

export function createRunMcpPromptTool(runtime: Pick<PromptRuntime, "getPrompt">): Tool {
  return {
    name: "RunMcpPrompt",
    description: "Run an MCP prompt by server, name, and arguments.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: true }
      },
      required: ["server", "name"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input) {
      const value = requiredObject(input);
      const server = requiredString(value, "server");
      const name = requiredString(value, "name");
      const args = value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
        ? value.arguments as Record<string, unknown>
        : {};
      const prompt = await runtime.getPrompt(server, name, args);
      return { output: JSON.stringify(prompt), data: prompt };
    }
  };
}

function optionalString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}
```

- [ ] **Step 4: Register prompt tools**

Modify `src/tools/registry.ts`:

```ts
import { createGetMcpPromptTool, createListMcpPromptsTool, createRunMcpPromptTool } from "../mcp/promptTools.js";
```

Inside `if (options.mcpRuntime)`:

```ts
registry.add(createListMcpPromptsTool(options.mcpRuntime));
registry.add(createGetMcpPromptTool(options.mcpRuntime));
registry.add(createRunMcpPromptTool(options.mcpRuntime));
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/promptTools.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/promptTools.ts src/tools/registry.ts tests/mcp/promptTools.test.ts
git commit -m "feat: add MCP prompt tools"
```

## Task 8: Wire MCP Runtime Into App Construction

**Files:**

- Modify: `src/runtime/types.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/cli/dispatch.ts` or the central runtime/session construction site that currently calls `createLocalToolRegistry`
- Test: `tests/mcp/connectionManager.test.ts`
- Test: existing runtime or CLI smoke tests

- [ ] **Step 1: Find the central tool registry construction call sites**

Run:

```bash
rg -n "createLocalToolRegistry|createPlanModeToolRegistry" src tests
```

Expected: list every construction site that needs an optional `mcpRuntime`.

- [ ] **Step 2: Add a failing integration test for optional MCP runtime registration**

Add to `tests/mcp/connectionManager.test.ts`:

```ts
import { createLocalToolRegistry } from "../../src/tools/registry.js";

it("registers MCP tools when runtime is supplied", async () => {
  const runtime = new McpRuntime({
    clientFactory: async () => new FakeMcpClient([{ name: "search", description: "Search", inputSchema: { type: "object" } }])
  });
  await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);

  const registry = createLocalToolRegistry({ mcpRuntime: runtime });

  assert.ok(registry.get("ToolSearch"));
  assert.ok(registry.get("ListMcpResources"));
  assert.ok(registry.get("ReadMcpResource"));
  assert.ok(registry.get("ListMcpPrompts"));
  assert.ok(registry.get("GetMcpPrompt"));
  assert.ok(registry.get("RunMcpPrompt"));
  assert.ok(registry.get("mcp__docs__search"));
});
```

- [ ] **Step 3: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: failure because `createLocalToolRegistry` does not accept `mcpRuntime` or tools are not registered.

- [ ] **Step 4: Add optional `mcpRuntime` to registry factory**

In `src/tools/registry.ts`, use the imports and registration snippets from Tasks 5, 6, and 7.

Ensure no-MCP behavior remains identical:

```ts
export function createLocalToolRegistry(options: { mcpRuntime?: McpRuntime } = {}): ToolRegistry {
```

- [ ] **Step 5: Pass runtime from app construction**

At the central session or CLI construction site:

1. Load merged MCP servers with `loadMergedMcpServers`.
2. Create `McpRuntime` with `createMcpClientFactory`.
3. Call `connectAll`.
4. Pass `{ mcpRuntime }` to `createLocalToolRegistry`.

Implementation shape:

```ts
const mcpServers = await loadMergedMcpServers({
  cwd,
  agentTeamServers: config.mcpServers
});
const mcpRuntime = new McpRuntime({
  clientFactory: createMcpClientFactory()
});
await mcpRuntime.connectAll(mcpServers);
const tools = createLocalToolRegistry({ mcpRuntime });
```

If the construction path has no async setup point, create a small async bootstrap helper rather than hiding connection startup inside `createLocalToolRegistry`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js dist-test/tests/runtime/turnExecutor.test.js dist-test/tests/cli.smoke.test.js
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/types.ts src/tools/registry.ts src/cli/dispatch.ts tests/mcp/connectionManager.test.ts
git commit -m "feat: wire MCP runtime into tools"
```

If the construction file is not `src/cli/dispatch.ts`, replace it in the commit command with the actual file found in Step 1.

## Task 9: Add Diagnostics and Status Accessors

**Files:**

- Modify: `src/mcp/runtime.ts`
- Test: `tests/mcp/connectionManager.test.ts`

- [ ] **Step 1: Add failing diagnostics test**

Append to `tests/mcp/connectionManager.test.ts`:

```ts
it("returns MCP diagnostics for connected, failed, and disabled servers", async () => {
  const runtime = new McpRuntime({
    clientFactory: async (server) => {
      if (server.name === "bad") throw new Error("boom");
      return new FakeMcpClient([{ name: "search", description: "Search", inputSchema: { type: "object" } }]);
    }
  });

  await runtime.connectAll([
    { name: "ok", source: "project", type: "http", url: "https://ok.example.test" },
    { name: "bad", source: "project", type: "http", url: "https://bad.example.test" },
    { name: "off", source: "project", type: "http", url: "https://off.example.test", disabled: true }
  ]);

  const diagnostics = runtime.getDiagnostics();

  assert.deepEqual(diagnostics.map((item) => item.state).sort(), ["connected", "disabled", "failed"]);
  assert.equal(diagnostics.find((item) => item.name === "ok")?.toolCount, 1);
  assert.equal(diagnostics.find((item) => item.name === "bad")?.error, "boom");
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: failure because `getDiagnostics` does not exist.

- [ ] **Step 3: Implement diagnostics**

Add to `src/mcp/runtime.ts`:

```ts
export type McpRuntimeDiagnostic = McpServerStatus & {
  source: ResolvedMcpServerConfig["source"];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
};
```

Add method:

```ts
getDiagnostics(): McpRuntimeDiagnostic[] {
  return [...this.servers.values()].map((record) => ({
    ...record.status,
    source: record.config.source,
    toolCount: record.tools.length,
    resourceCount: record.resources.length,
    promptCount: record.prompts.length
  }));
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run build:test
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/connectionManager.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/runtime.ts tests/mcp/connectionManager.test.ts
git commit -m "feat: add MCP runtime diagnostics"
```

## Task 10: Final Verification for MCP Phase 1

**Files:**

- Modify only if verification finds defects.

- [ ] **Step 1: Run TypeScript test build**

Run:

```bash
npm run build:test
```

Expected: TypeScript build succeeds.

- [ ] **Step 2: Run focused MCP and affected tests**

Run:

```bash
node .tmp/run-selected-tests.mjs dist-test/tests/mcp/config.test.js dist-test/tests/mcp/connectionManager.test.js dist-test/tests/mcp/deferredTools.test.js dist-test/tests/mcp/resourceTools.test.js dist-test/tests/mcp/promptTools.test.js dist-test/tests/config/loadConfig.test.js dist-test/tests/settings/settings.test.js dist-test/tests/runtime/turnExecutor.test.js dist-test/tests/kernel/queryEngine.test.js dist-test/tests/cli.smoke.test.js
```

Expected: all tests pass within the command timeout.

- [ ] **Step 3: Inspect git diff for accidental Skill or Hook implementation**

Run:

```bash
git diff -- src tests package.json package-lock.json
```

Expected: changes are limited to MCP, config, settings path, registry wiring, and tests. No SkillRuntime or HookRuntime implementation appears in this phase.

- [ ] **Step 4: Commit any verification fixes**

If Step 1 or Step 2 required fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize MCP phase one"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

Spec coverage:

- MCP transports are covered by Task 4.
- MCP config sources and precedence are covered by Tasks 1 and 2.
- `~/.einsteins/settings.yaml` fallback behavior is covered by Task 2.
- Tools, resources, and prompts are covered by Tasks 5, 6, and 7.
- Deferred tool discovery is covered by Task 5.
- Runtime connection status and failure isolation are covered by Tasks 3 and 9.
- TUI diagnostics are not implemented in this phase; runtime diagnostics are prepared for the later TUI phase.
- Skill and Hook implementation are intentionally excluded from this MCP plan.

Placeholder scan:

- The plan contains no placeholder markers or unspecified implementation steps.
- Each code-changing task contains concrete code or exact implementation shape.

Type consistency:

- `McpRuntime`, `McpClient`, `ResolvedMcpServerConfig`, `RuntimeMcpTool`, and `McpRuntimeDiagnostic` names are used consistently.
- Tool names are consistently `ToolSearch`, `ListMcpResources`, `ReadMcpResource`, `ListMcpPrompts`, `GetMcpPrompt`, and `RunMcpPrompt`.

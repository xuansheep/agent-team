import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMcpConfigSources, mergeMcpServers } from "../../src/mcp/config.js";
import { mcpServersSchema } from "../../src/mcp/schema.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-mcp-config-"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

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

  it("merges MCP servers with agent-team precedence over project and user", () => {
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
});

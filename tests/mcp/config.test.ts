import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMcpConfigSources, loadMergedMcpServersWithSourceDetails, mergeMcpServers } from "../../src/mcp/config.js";
import { setMcpServerDisabledState } from "../../src/mcp/configMutations.js";
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

  it("merges project MCP servers with precedence over user servers", () => {
    const merged = mergeMcpServers({
      user: { shared: { type: "stdio", command: "user" }, userOnly: { type: "stdio", command: "user-only" } },
      project: { shared: { type: "stdio", command: "project" }, projectOnly: { type: "http", url: "https://project.example.test" } }
    });

    assert.equal(merged.find((server) => server.name === "shared")?.source, "project");
    assert.equal((merged.find((server) => server.name === "shared") as { command?: string }).command, "project");
    assert.equal(merged.find((server) => server.name === "projectOnly")?.source, "project");
    assert.equal(merged.find((server) => server.name === "userOnly")?.source, "user");
  });

  it("loads MCP servers from user and project settings", async () => {
    const cwd = await tempWorkspace();
    const userPath = join(cwd, "user-settings.json");
    const projectPath = join(cwd, ".einsteins", "settings.json");
    await writeJson(userPath, { mcpServers: { userServer: { type: "stdio", command: "user" } } });
    await writeJson(projectPath, { mcpServers: { projectServer: { type: "http", url: "https://project.example.test" } } });

    const sources = await loadMcpConfigSources({ cwd, userSettingsPath: userPath, projectSettingsPath: projectPath });

    assert.equal(sources.user?.userServer?.type, "stdio");
    assert.equal(sources.project?.projectServer?.type, "http");
  });

  it("returns source paths for merged MCP servers", async () => {
    const cwd = await tempWorkspace();
    const userPath = join(cwd, "user-settings.json");
    const projectPath = join(cwd, ".einsteins", "settings.json");
    await writeJson(userPath, { mcpServers: { shared: { type: "stdio", command: "user" } } });
    await writeJson(projectPath, { mcpServers: { shared: { type: "stdio", command: "project" } } });

    const merged = await loadMergedMcpServersWithSourceDetails({ cwd, userSettingsPath: userPath, projectSettingsPath: projectPath });

    assert.equal(merged[0]?.name, "shared");
    assert.equal(merged[0]?.source, "project");
    assert.equal(merged[0]?.sourcePath, projectPath);
    assert.equal(merged[0]?.sourceFormat, "json");
  });

  it("writes disabled state as a local project override without expanding stored secrets", async () => {
    const cwd = await tempWorkspace();
    const userPath = join(cwd, "user-settings.json");
    const projectPath = join(cwd, ".einsteins", "settings.json");
    const previousToken = process.env.AGENT_TEAM_TEST_MCP_TOKEN;
    process.env.AGENT_TEAM_TEST_MCP_TOKEN = "resolved-token";
    try {
      await writeJson(userPath, {
        permissions: { defaultMode: "plan" },
        mcpServers: {
          shared: { type: "stdio", command: "user" },
          secret: {
            type: "http",
            url: "https://user.example.test",
            headers: { Authorization: "Bearer ${AGENT_TEAM_TEST_MCP_TOKEN}" }
          }
        }
      });
      await writeJson(projectPath, { mcpServers: { shared: { type: "stdio", command: "project" } } });

      await setMcpServerDisabledState({ cwd, userSettingsPath: userPath, projectSettingsPath: projectPath }, "shared", true);

      const stored = JSON.parse(await readFile(userPath, "utf8"));
      assert.equal(stored.permissions.defaultMode, "plan");
      assert.equal(stored.mcpServers.secret.headers.Authorization, "Bearer ${AGENT_TEAM_TEST_MCP_TOKEN}");
      assert.deepEqual(stored.projects[resolve(cwd)].disabledMcpServers, ["shared"]);
      assert.equal(JSON.parse(await readFile(projectPath, "utf8")).mcpServers.shared.disabled, undefined);
      assert.equal((await loadMergedMcpServersWithSourceDetails({ cwd, userSettingsPath: userPath, projectSettingsPath: projectPath })).find((server) => server.name === "shared")?.disabled, true);
    } finally {
      if (previousToken === undefined) delete process.env.AGENT_TEAM_TEST_MCP_TOKEN;
      else process.env.AGENT_TEAM_TEST_MCP_TOKEN = previousToken;
    }
  });

  it("enables JSON servers with a local project override", async () => {
    const cwd = await tempWorkspace();
    const userPath = join(cwd, "user-settings.json");
    const projectPath = join(cwd, ".einsteins", "settings.json");
    await writeJson(projectPath, { mcpServers: { docs: { type: "http", url: "https://project.example.test", disabled: true } } });

    await setMcpServerDisabledState({ cwd, userSettingsPath: userPath, projectSettingsPath: projectPath }, "docs", false);

    const effective = await loadMergedMcpServersWithSourceDetails({ cwd, userSettingsPath: userPath, projectSettingsPath: projectPath });
    assert.equal(effective.find((server) => server.name === "docs")?.disabled, false);
  });

  it("ignores legacy user and project MCP files", async () => {
    const cwd = await tempWorkspace();
    const userPath = join(cwd, ".einsteins", "settings.json");
    const projectPath = join(cwd, "project", ".einsteins", "settings.json");
    await writeJson(userPath, {});
    await writeJson(join(cwd, ".einsteins.json"), { mcpServers: { legacyUser: { type: "stdio", command: "legacy-user" } } });
    await writeJson(join(cwd, "project", ".mcp.json"), { mcpServers: { legacyProject: { type: "stdio", command: "legacy-project" } } });

    const merged = await loadMergedMcpServersWithSourceDetails({
      cwd: join(cwd, "project"),
      userSettingsPath: userPath,
      projectSettingsPath: projectPath
    });

    assert.deepEqual(merged, []);
  });

  it("throws without creating a missing MCP server", async () => {
    const cwd = await tempWorkspace();
    const projectPath = join(cwd, ".einsteins", "settings.json");
    await writeJson(projectPath, { mcpServers: { docs: { type: "http", url: "https://project.example.test" } } });

    await assert.rejects(setMcpServerDisabledState({ cwd, userSettingsPath: join(cwd, "user-settings.json"), projectSettingsPath: projectPath }, "missing", true), /Unknown MCP server missing/);

    assert.equal(JSON.parse(await readFile(projectPath, "utf8")).mcpServers.missing, undefined);
  });

});

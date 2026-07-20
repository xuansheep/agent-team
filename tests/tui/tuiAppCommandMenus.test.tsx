import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { SkillRuntime } from "../../src/skills/runtime.js";
import { buildCommandMenuChoice } from "../../src/tui/TuiApp.js";
import type { RuntimeDiagnostics } from "../../src/diagnostics/runtimeDiagnostics.js";
import type { CommandMenuState } from "../../src/tui/TuiApp.js";
import type { McpMenuAction } from "../../src/tui/commandMenus/index.js";

function menu(input: { state: CommandMenuState; diagnostics: RuntimeDiagnostics; mcpRuntime?: McpRuntime; runMcpAction?: (action: McpMenuAction, serverName?: string) => Promise<void> }) {
  let nextState: CommandMenuState | undefined;
  let closed = "";
  const choice = buildCommandMenuChoice({
    state: input.state,
    diagnostics: input.diagnostics,
    mcpRuntime: input.mcpRuntime,
    statuslineElements: ["mode", "workflow"],
    setStatuslineElements: () => undefined,
    setCommandMenu: (state) => { nextState = state; },
    closeCommandMenu: (message) => { closed = message; },
    runMcpAction: input.runMcpAction ?? (async () => undefined)
  });
  return { choice, nextState: () => nextState, closed: () => closed };
}

describe("TuiApp command menus", () => {
  it("builds and closes the skills menu through TuiApp wiring", () => {
    const skillRuntime = new SkillRuntime([{ name: "planner", prompt: "Plan.", path: "SKILL.md", root: ".", source: "project", mode: "inline" }]);
    const result = menu({ state: { kind: "skills:list" }, diagnostics: { mcp: [], skills: skillRuntime.getDiagnostics() } });

    assert.equal(result.choice?.title, "Skills");
    assert.equal(result.choice?.options[0]?.value, "planner");
    result.choice?.onCancel?.();
    assert.equal(result.closed(), "Skills dialog dismissed");
  });

  it("routes mcp bulk disable through the supplied action handler", async () => {
    const runtime = new McpRuntime({ clientFactory: async () => ({ listTools: async () => [], callTool: async () => ({}), listResources: async () => [], readResource: async () => ({}), listPrompts: async () => [], getPrompt: async () => ({}) }) });
    await runtime.connectAll([{ name: "docs", source: "project", type: "http", url: "https://mcp.example.test" }]);
    const calls: Array<{ action: McpMenuAction; serverName?: string }> = [];
    const result = menu({
      state: { kind: "mcp:list" },
      diagnostics: { mcp: runtime.getDiagnostics(), skills: [] },
      mcpRuntime: runtime,
      runMcpAction: async (action, serverName) => { calls.push({ action, serverName }); }
    });

    result.choice?.onSubmit("__disable_all__");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [{ action: "disable", serverName: undefined }]);
  });
});

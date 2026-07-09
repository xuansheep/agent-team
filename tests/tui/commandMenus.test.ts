import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHooksEventChoice, buildHooksHookChoice, buildHooksHookDetailChoice } from "../../src/tui/commandMenus/hooksMenu.js";
import { buildMcpListChoice, buildMcpServerChoice, buildMcpToolDetailChoice } from "../../src/tui/commandMenus/mcpMenu.js";
import { buildSkillsDetailChoice, buildSkillsListChoice } from "../../src/tui/commandMenus/skillsMenu.js";

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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMcpListChoice, buildMcpServerChoice, buildMcpToolDetailChoice } from "../../src/tui/commandMenus/mcpMenu.js";
import { buildSkillsDetailChoice, buildSkillsListChoice } from "../../src/tui/commandMenus/skillsMenu.js";
import { buildStatuslineChoice } from "../../src/tui/commandMenus/statuslineMenu.js";

const noop = () => undefined;

describe("command menu builders", () => {
  it("builds skills list and detail choices", () => {
    const skills = [{ name: "planner", source: "project" as const, mode: "inline" as const, path: "SKILL.md", allowedTools: ["Read"], description: "Plan", whenToUse: "Use before coding" }];

    assert.deepEqual(buildSkillsListChoice({ skills, onSelect: noop, onCancel: noop }).options.map((item) => item.value), ["planner"]);
    assert.match(buildSkillsDetailChoice({ skill: skills[0]!, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /whenToUse: Use before coding/);
  });

  it("builds an immediately applied statusline checklist in canonical order", () => {
    const changes: string[][] = [];
    const choice = buildStatuslineChoice({
      selectedElements: ["workflow", "mode"],
      onChange: (elements) => changes.push(elements),
      onClose: noop
    });

    assert.deepEqual(choice.options.map((item) => item.value), ["mode", "permission", "workflow", "run", "selection", "loading"]);
    assert.deepEqual(choice.selectedValues, ["mode", "workflow"]);
    assert.equal(choice.multiSelect, true);
    assert.equal(choice.submitButtonText, "Close");

    choice.onChangeValues?.(["loading", "mode"]);
    choice.onChangeValues?.([]);
    assert.deepEqual(changes, [["mode", "loading"], []]);
  });

  it("builds an empty mcp list", () => {
    const choice = buildMcpListChoice({ servers: [], onSelect: noop, onAction: noop, onCancel: noop });

    assert.equal(choice.detail, "No MCP servers configured");
    assert.deepEqual(choice.options, [{ label: "No MCP servers", value: "__empty__", disabled: true }]);
  });

  it("builds mcp choices", () => {
    const servers = [{ name: "docs", state: "connected" as const, source: "project" as const, sourcePath: "D:/repo/.einsteins/settings.json", sourceFormat: "json" as const, transport: "http" as const, toolCount: 1, resourceCount: 0, promptCount: 0 }];
    const tools = [{ server: "docs", name: "mcp__docs__search", originalName: "search", description: "Search", inputSchema: { type: "object" } }];

    assert.equal(buildMcpListChoice({ servers, onSelect: noop, onAction: noop, onCancel: noop }).title, "MCP Servers");
    assert.match(buildMcpServerChoice({ server: servers[0]!, tools, onSelectTools: noop, onAction: noop, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /sourcePath: D:\/repo/);
    assert.match(buildMcpToolDetailChoice({ tool: tools[0]!, onBack: noop, onCancel: noop }).documentBlock?.text ?? "", /inputSchema:/);
  });
});

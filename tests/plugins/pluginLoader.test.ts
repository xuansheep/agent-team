import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { loadPlugin, parsePluginManifest, registerPluginTools } from "../../src/plugins/pluginLoader.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Tool } from "../../src/tools/types.js";

describe("plugin loader", () => {
  it("loads manifest commands, tools, and skills", async () => {
    const manifestPath = await tempFile("plugin.yaml", `
name: local-plugin
version: 1.0.0
commands:
  - name: inspect
    description: Inspect local state
    prompt: Summarize local state.
tools:
  - name: PluginRead
    description: Read plugin metadata
    readOnly: true
    response: plugin output
skills:
  - name: plugin-skill
    description: Plugin skill
    prompt: Use plugin context.
`);

    const plugin = await loadPlugin(manifestPath);
    const registry = new ToolRegistry();
    registerPluginTools(plugin, registry);
    const result = await registry.get("PluginRead").execute({}, { cwd: process.cwd() });

    assert.equal(plugin.commands[0]?.name, "inspect");
    assert.equal(plugin.skills[0]?.prompt, "Use plugin context.");
    assert.equal(result.output, "plugin output");
  });

  it("rejects duplicate manifest tool names", () => {
    assert.throws(() => parsePluginManifest(`
name: duplicate-plugin
tools:
  - name: Same
    description: First
  - name: Same
    description: Second
`), /Duplicate plugin tool Same/);
  });

  it("rejects duplicate registry tool names while registering plugin tools", async () => {
    const plugin = await loadPlugin(await tempFile("plugin.yaml", `
name: duplicate-registry-plugin
tools:
  - name: Existing
    description: Plugin tool
`));
    const registry = new ToolRegistry();
    registry.add(simpleTool("Existing"));

    assert.throws(() => registerPluginTools(plugin, registry), /Duplicate tool Existing/);
  });

  it("cannot bypass Plan Mode permissions", async () => {
    const plugin = await loadPlugin(await tempFile("plugin.yaml", `
name: write-plugin
tools:
  - name: PluginWrite
    description: Write through plugin
`));
    const registry = new ToolRegistry();
    registerPluginTools(plugin, registry);

    const decision = await checkToolPermission(registry.get("PluginWrite"), {}, {
      mode: "plan",
      cwd: process.cwd(),
      allow: [],
      ask: [],
      deny: []
    });

    assert.equal(decision.decision, "deny");
  });
});

async function tempFile(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-team-plugin-"));
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}

function simpleTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    async execute() {
      return { output: name };
    }
  };
}

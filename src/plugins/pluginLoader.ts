import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { Tool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { PluginCommandManifest, PluginManifest, PluginSkillManifest, PluginToolManifest, pluginManifestSchema } from "./manifest.js";

export type LoadedPlugin = {
  manifest: PluginManifest;
  commands: PluginCommandManifest[];
  tools: Tool[];
  skills: PluginSkillManifest[];
};

export async function loadPluginManifest(path: string): Promise<PluginManifest> {
  const raw = await readFile(path, "utf8");
  return parsePluginManifest(raw);
}

export function parsePluginManifest(raw: string): PluginManifest {
  const manifest = pluginManifestSchema.parse(yaml.load(raw) ?? {});
  assertUnique("plugin command", manifest.commands.map((command) => command.name));
  assertUnique("plugin tool", manifest.tools.map((tool) => tool.name));
  assertUnique("plugin skill", manifest.skills.map((skill) => skill.name));
  return manifest;
}

export async function loadPlugin(path: string): Promise<LoadedPlugin> {
  return pluginFromManifest(await loadPluginManifest(path));
}

export function pluginFromManifest(manifest: PluginManifest): LoadedPlugin {
  return {
    manifest,
    commands: manifest.commands,
    tools: manifest.tools.map(pluginToolToTool),
    skills: manifest.skills
  };
}

export function registerPluginTools(plugin: LoadedPlugin, registry: ToolRegistry): void {
  for (const tool of plugin.tools) registry.add(tool);
}

function pluginToolToTool(definition: PluginToolManifest): Tool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema,
    isReadOnly: () => definition.readOnly,
    isConcurrencySafe: () => definition.readOnly,
    isDestructive: () => definition.destructive,
    async execute(input) {
      return {
        output: definition.response ?? JSON.stringify({ tool: definition.name, input }),
        data: { plugin_tool: definition.name, input }
      };
    }
  };
}

function assertUnique(label: string, names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${label} ${name}`);
    seen.add(name);
  }
}

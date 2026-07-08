import type { McpPrompt } from "../mcp/types.js";
import type { LoadedSkill } from "./skillLoader.js";

type McpPromptSkillRuntime = {
  listPrompts(input?: { server?: string }): Promise<Array<McpPrompt & { server: string }>>;
};

export async function loadMcpPromptSkills(runtime: McpPromptSkillRuntime): Promise<LoadedSkill[]> {
  const prompts = await runtime.listPrompts();
  return prompts.map((prompt) => ({
    name: mcpSkillName(prompt.server, prompt.name),
    description: prompt.description,
    prompt: mcpSkillPrompt(prompt),
    path: `mcp://${prompt.server}/prompts/${prompt.name}`,
    root: `mcp://${prompt.server}/prompts`,
    source: "mcp",
    metadata: {
      mcpServer: prompt.server,
      mcpPrompt: prompt.name,
      arguments: prompt.arguments ?? []
    }
  }));
}

function mcpSkillName(server: string, prompt: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(prompt)}`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function mcpSkillPrompt(prompt: McpPrompt & { server: string }): string {
  const args = prompt.arguments?.length
    ? `\nArguments: ${prompt.arguments.map((arg) => `${arg.name}${arg.required ? " required" : ""}`).join(", ")}`
    : "";
  return [
    `This skill is backed by MCP prompt ${prompt.server}/${prompt.name}.`,
    "Use the RunMcpPrompt tool with this server, prompt name, and required arguments when the skill is selected.",
    `Server: ${prompt.server}`,
    `Prompt: ${prompt.name}${args}`
  ].join("\n");
}

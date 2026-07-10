import type { McpResource } from "../mcp/types.js";
import { parseSkillMarkdown, type LoadedSkill } from "./skillLoader.js";

type McpSkillRuntime = {
  listResources(input?: { server?: string }): Promise<Array<McpResource & { server: string }>>;
  readResource(server: string, uri: string): Promise<unknown>;
};

export async function loadMcpResourceSkills(runtime: McpSkillRuntime): Promise<LoadedSkill[]> {
  const resources = (await runtime.listResources()).filter((resource) => resource.uri.startsWith("skill://"));
  const loaded = await Promise.all(resources.map(async (resource) => {
    try {
      const result = await runtime.readResource(resource.server, resource.uri);
      const markdown = resourceText(result);
      if (markdown === undefined) return undefined;
      const parsed = parseSkillMarkdown(markdown, resource.uri);
      return {
        ...parsed,
        description: parsed.description ?? resource.description,
        path: resource.uri,
        root: skillResourceRoot(resource.uri),
        source: "mcp" as const,
        shell: undefined,
        metadata: { ...parsed.metadata, mcpServer: resource.server, mcpResource: resource.uri }
      };
    } catch {
      return undefined;
    }
  }));
  return loaded.flatMap((skill) => skill ? [skill as LoadedSkill] : []);
}

export const loadMcpPromptSkills = loadMcpResourceSkills;

function resourceText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const contents = (result as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return undefined;
  const texts = contents.flatMap((content) => {
    if (!content || typeof content !== "object" || Array.isArray(content)) return [];
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
  return texts.length ? texts.join("\n") : undefined;
}

function skillResourceRoot(uri: string): string {
  const slash = uri.lastIndexOf("/");
  return slash > "skill://".length ? uri.slice(0, slash) : uri;
}
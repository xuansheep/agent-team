import type { Tool } from "../tools/types.js";
import type { RuntimeMcpTool } from "./runtime.js";
import type { McpToolCallResult } from "./types.js";

export type McpToolSearchRuntime = { listTools(): RuntimeMcpTool[]; getServerInstructions?(): string[]; callTool?(server: string, originalName: string, input: unknown): Promise<McpToolCallResult> };
export type DeferredMcpToolRuntime = { callTool(server: string, originalName: string, input: unknown): Promise<McpToolCallResult> };

export function createMcpToolSearchTool(runtime: McpToolSearchRuntime): Tool {
  return {
    name: "ToolSearch",
    description: "Search local and MCP tools, loading matching MCP tools into the current session.",
    prompt: () => runtime.getServerInstructions?.().join("\n\n") ?? "",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["query"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      const value = objectInput(input);
      const query = value.query.toLowerCase();
      const localMatches = (context.toolRegistry?.list() ?? [])
        .filter((tool) => tool.name !== "ToolSearch" && searchable(tool.name, tool.description, query))
        .map((tool) => ({ name: tool.name, description: tool.description, source: "local" as const }));
      const mcpMatches = runtime.listTools()
        .filter((tool) => searchable(`${tool.name} ${tool.originalName}`, tool.description, query))
        .map((tool) => ({ name: tool.name, description: tool.description, source: "mcp" as const, tool }));
      const matches = [...localMatches, ...mcpMatches].slice(0, value.maxResults);
      for (const match of matches) {
        if (match.source === "mcp" && runtime.callTool && context.toolRegistry && !context.toolRegistry.has(match.name)) {
          context.toolRegistry.add(createDeferredMcpTool(match.tool, { callTool: runtime.callTool.bind(runtime) }));
        }
      }
      return {
        output: matches.map((match) => `${match.name}: ${match.description ?? ""}`).join("\n"),
        data: matches.map(({ name, description, source }) => ({ name, description, source, loaded: source === "local" || Boolean(context.toolRegistry?.has(name)) }))
      };
    }
  };
}

export function createDeferredMcpTool(tool: RuntimeMcpTool, runtime: DeferredMcpToolRuntime): Tool {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool ${tool.originalName} from ${tool.server}`,
    input_schema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    isReadOnly: () => tool.annotations?.readOnlyHint === true,
    isDestructive: () => tool.annotations?.destructiveHint === true,
    isConcurrencySafe: () => tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
    async execute(input) {
      const data = await runtime.callTool(tool.server, tool.originalName, input ?? {});
      return { output: toolResultText(data), ...(data.isError ? { error: toolResultText(data) } : {}), data };
    },
    mapToolResultToModelResult(result) {
      return result.data ?? result.output ?? result.error;
    }
  };
}

function objectInput(input: unknown): { query: string; maxResults: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ToolSearch input must be an object");
  const record = input as { query?: unknown; max_results?: unknown };
  if (typeof record.query !== "string" || !record.query.trim()) throw new Error("ToolSearch query is required");
  const maxResults = typeof record.max_results === "number" && Number.isInteger(record.max_results) ? Math.min(20, Math.max(1, record.max_results)) : 10;
  return { query: record.query.trim(), maxResults };
}

function searchable(name: string, description: string | undefined, query: string): boolean {
  const terms = query.split(/\s+/).filter(Boolean);
  const haystack = `${name} ${description ?? ""}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function toolResultText(result: McpToolCallResult): string {
  const text = (result.content ?? []).flatMap((content) => content.type === "text" && typeof content.text === "string" ? [content.text] : []).join("\n");
  if (text) return text;
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}
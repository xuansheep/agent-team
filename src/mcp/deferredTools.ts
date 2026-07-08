import type { Tool } from "../tools/types.js";
import type { RuntimeMcpTool } from "./runtime.js";

export type McpToolSearchRuntime = {
  listTools(): RuntimeMcpTool[];
};

export type DeferredMcpToolRuntime = {
  callTool(server: string, originalName: string, input: unknown): Promise<unknown>;
};

export function createMcpToolSearchTool(runtime: McpToolSearchRuntime): Tool {
  return {
    name: "ToolSearch",
    description: "Search available local and MCP tools by query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const query = objectInput(input).query.toLowerCase();
      const matches = runtime.listTools().filter((tool) =>
        tool.name.toLowerCase().includes(query) ||
        tool.originalName.toLowerCase().includes(query) ||
        (tool.description ?? "").toLowerCase().includes(query)
      );
      return {
        output: matches.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n"),
        data: matches
      };
    }
  };
}

export function createDeferredMcpTool(tool: RuntimeMcpTool, runtime: DeferredMcpToolRuntime): Tool {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool ${tool.originalName} from ${tool.server}`,
    input_schema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    async execute(input) {
      const data = await runtime.callTool(tool.server, tool.originalName, input ?? {});
      return {
        output: typeof data === "string" ? data : JSON.stringify(data),
        data
      };
    },
    mapToolResultToModelResult(result) {
      return result.data ?? result.output ?? result.error;
    }
  };
}

function objectInput(input: unknown): { query: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ToolSearch input must be an object");
  const query = (input as { query?: unknown }).query;
  if (typeof query !== "string" || !query.trim()) throw new Error("ToolSearch query is required");
  return { query };
}

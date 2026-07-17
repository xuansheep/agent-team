import type { Tool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { McpServerStatus, RuntimeMcpTool } from "./runtime.js";
import type { McpToolCallResult } from "./types.js";

export type McpToolSearchRuntime = {
  listTools(): RuntimeMcpTool[];
  listServerStatuses?(): McpServerStatus[];
  getCatalogRevision?(): number;
  getServerInstructions?(): string[];
  callTool?(server: string, originalName: string, input: unknown): Promise<McpToolCallResult>;
};

export type DeferredMcpToolRuntime = {
  callTool(server: string, originalName: string, input: unknown): Promise<McpToolCallResult>;
};

export type McpToolSearchMatch = {
  name: string;
  description?: string;
  source: "local" | "mcp";
  loaded: boolean;
};

export type McpToolSearchData = {
  query: string;
  matches: McpToolSearchMatch[];
  total_deferred_tools: number;
  pending_mcp_servers?: string[];
  missing?: string[];
};

type SearchCandidate = {
  tool: RuntimeMcpTool;
  parts: string[];
  full: string;
  description: string;
  hint: string;
};

export function createMcpToolSearchTool(runtime: McpToolSearchRuntime): Tool {
  let cachedRevision = -1;
  let cachedKey = "";
  let cachedCandidates: SearchCandidate[] = [];

  const candidates = (): SearchCandidate[] => {
    const tools = runtime.listTools();
    const revision = runtime.getCatalogRevision?.() ?? -1;
    const key = tools.map((tool) => [tool.name, tool.description ?? "", searchHint(tool)].join("\u0000")).sort().join("\u0001");
    if (cachedRevision === revision && cachedKey === key) return cachedCandidates;
    cachedRevision = revision;
    cachedKey = key;
    cachedCandidates = tools.map((tool) => {
      const parsed = parseToolName(tool.name);
      return {
        tool,
        parts: parsed.parts,
        full: parsed.full,
        description: (tool.description ?? "").toLowerCase(),
        hint: searchHint(tool).toLowerCase()
      };
    });
    return cachedCandidates;
  };

  return {
    name: "ToolSearch",
    description: "Fetch full schemas for deferred MCP tools. Supports select:ToolA,ToolB, exact names, MCP prefixes, keywords, and +required terms.",
    prompt: () => runtime.getServerInstructions?.().join("\n\n") ?? "",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 20, default: 5 }
      },
      required: ["query"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      const value = objectInput(input);
      if (context.toolRegistry) syncMcpRegistry(context.toolRegistry, runtime);
      const allCandidates = candidates();
      const deferred = allCandidates.filter((candidate) => !context.toolRegistry?.has(candidate.tool.name));
      const selected = selectedToolNames(value.query, allCandidates, context.toolRegistry, value.maxResults);
      const found = selected ?? searchCandidates(value.query, deferred, value.maxResults);
      const missing = selected?.missing ?? [];
      const matches: McpToolSearchMatch[] = [];

      for (const item of found.matches) {
        if (item.source === "mcp" && runtime.callTool && context.toolRegistry && !context.toolRegistry.has(item.name)) {
          const candidate = allCandidates.find((entry) => entry.tool.name === item.name);
          if (candidate) context.toolRegistry.add(createDeferredMcpTool(candidate.tool, { callTool: runtime.callTool.bind(runtime) }));
        }
        matches.push({
          name: item.name,
          description: item.description,
          source: item.source,
          loaded: item.source === "local" || Boolean(context.toolRegistry?.has(item.name))
        });
      }

      const pending = matches.length === 0
        ? runtime.listServerStatuses?.().filter((status) => status.state === "pending").map((status) => status.name)
        : undefined;
      const data: McpToolSearchData = {
        query: value.query,
        matches,
        total_deferred_tools: deferred.length,
        ...(pending?.length ? { pending_mcp_servers: pending } : {}),
        ...(missing.length ? { missing } : {})
      };
      return { output: formatSearchOutput(data), data };
    }
  };
}

export function syncMcpRegistry(registry: ToolRegistry, runtime: McpToolSearchRuntime): void {
  const available = new Map(runtime.listTools().map((tool) => [tool.name, tool]));
  for (const name of registry.names()) {
    if (name.startsWith("mcp__") && !available.has(name)) registry.remove(name);
  }
  if (!runtime.callTool) return;
  for (const tool of available.values()) {
    if (mcpToolAlwaysLoad(tool) && !registry.has(tool.name)) {
      registry.add(createDeferredMcpTool(tool, { callTool: runtime.callTool.bind(runtime) }));
    }
  }
}

export function mcpToolAlwaysLoad(tool: RuntimeMcpTool): boolean {
  return tool._meta?.["anthropic/alwaysLoad"] === true;
}

export function createDeferredMcpTool(tool: RuntimeMcpTool, runtime: DeferredMcpToolRuntime): Tool {
  return {
    name: tool.name,
    description: tool.description ?? "MCP tool " + tool.originalName + " from " + tool.server,
    input_schema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    isReadOnly: () => tool.annotations?.readOnlyHint === true,
    isDestructive: () => tool.annotations?.destructiveHint === true,
    isConcurrencySafe: () => tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
    async execute(input) {
      const data = await runtime.callTool(tool.server, tool.originalName, input ?? {});
      return { output: toolResultText(data), ...(data.isError ? { error: toolResultText(data), is_error: true } : {}), data };
    },
    mapToolResultToModelResult(result) {
      return result.data ?? result.output ?? result.error;
    }
  };
}

function selectedToolNames(
  query: string,
  candidates: SearchCandidate[],
  registry: ToolRegistry | undefined,
  maxResults: number
): { matches: Array<{ name: string; description?: string; source: "local" | "mcp" }>; missing: string[] } | undefined {
  const select = /^select:(.+)$/i.exec(query);
  const requested = select
    ? select[1].split(",").map((name) => name.trim()).filter(Boolean)
    : [query.trim()];
  const exactOnly = Boolean(select) || requested.length === 1;
  if (!exactOnly) return undefined;

  const matches: Array<{ name: string; description?: string; source: "local" | "mcp" }> = [];
  const missing: string[] = [];
  for (const requestedName of requested) {
    const candidate = candidates.find((entry) => entry.tool.name.toLowerCase() === requestedName.toLowerCase());
    if (candidate) {
      if (!matches.some((entry) => entry.name === candidate.tool.name)) {
        matches.push({ name: candidate.tool.name, description: candidate.tool.description, source: "mcp" });
      }
      continue;
    }
    const local = registry?.names().find((name) => name.toLowerCase() === requestedName.toLowerCase());
    if (local) {
      const tool = registry?.get(local);
      matches.push({ name: local, description: tool?.description, source: "local" });
      continue;
    }
    missing.push(requestedName);
  }
  if (!select && matches.length === 0) return undefined;
  return { matches: matches.slice(0, maxResults), missing };
}

function searchCandidates(
  query: string,
  candidates: SearchCandidate[],
  maxResults: number
): { matches: Array<{ name: string; description?: string; source: "mcp" }>; missing: string[] } {
  const lower = query.toLowerCase().trim();
  if (lower.startsWith("mcp__") && lower.length > 5) {
    const prefix = candidates
      .filter((candidate) => candidate.tool.name.toLowerCase().startsWith(lower))
      .slice(0, maxResults)
      .map((candidate) => ({ name: candidate.tool.name, description: candidate.tool.description, source: "mcp" as const }));
    if (prefix.length) return { matches: prefix, missing: [] };
  }

  const terms = lower.split(/\s+/).filter(Boolean);
  const required = terms.filter((term) => term.startsWith("+") && term.length > 1).map((term) => term.slice(1));
  const optional = terms.filter((term) => !term.startsWith("+"));
  const scoring = required.length ? [...required, ...optional] : terms;
  const scored = candidates.flatMap((candidate) => {
    if (!required.every((term) => candidateMatches(candidate, term))) return [];
    let score = 0;
    for (const term of scoring) {
      if (candidate.parts.includes(term)) score += 12;
      else if (candidate.parts.some((part) => part.includes(term))) score += 6;
      if (candidate.full.includes(term) && score === 0) score += 3;
      if (wordContains(candidate.hint, term)) score += 4;
      if (wordContains(candidate.description, term)) score += 2;
    }
    return score > 0 ? [{ candidate, score }] : [];
  });
  scored.sort((left, right) => right.score - left.score || left.candidate.tool.name.localeCompare(right.candidate.tool.name));
  return {
    matches: scored.slice(0, maxResults).map(({ candidate }) => ({
      name: candidate.tool.name,
      description: candidate.tool.description,
      source: "mcp" as const
    })),
    missing: []
  };
}

function candidateMatches(candidate: SearchCandidate, term: string): boolean {
  return candidate.parts.includes(term)
    || candidate.parts.some((part) => part.includes(term))
    || wordContains(candidate.description, term)
    || wordContains(candidate.hint, term);
}

function parseToolName(name: string): { parts: string[]; full: string } {
  const withoutPrefix = name.replace(/^mcp__/i, "");
  const parts = withoutPrefix
    .replace(/__/g, " ")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return { parts, full: parts.join(" ") };
}

function wordContains(text: string, term: string): boolean {
  if (!text) return false;
  return new RegExp("\\b" + escapeRegExp(term) + "\\b", "i").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
}

function searchHint(tool: RuntimeMcpTool): string {
  const hint = tool._meta?.["anthropic/searchHint"];
  return typeof hint === "string" ? hint : "";
}

function objectInput(input: unknown): { query: string; maxResults: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ToolSearch input must be an object");
  const record = input as { query?: unknown; max_results?: unknown };
  if (typeof record.query !== "string" || !record.query.trim()) throw new Error("ToolSearch query is required");
  const maxResults = typeof record.max_results === "number" && Number.isInteger(record.max_results)
    ? Math.min(20, Math.max(1, record.max_results))
    : 5;
  return { query: record.query.trim(), maxResults };
}

function formatSearchOutput(data: McpToolSearchData): string {
  if (!data.matches.length) {
    const pending = data.pending_mcp_servers?.length
      ? " Some MCP servers are still connecting: " + data.pending_mcp_servers.join(", ") + "."
      : "";
    const missing = data.missing?.length ? " Missing: " + data.missing.join(", ") + "." : "";
    return "No matching deferred tools found." + pending + missing;
  }
  const lines = data.matches.map((match) => match.name + ": " + (match.description ?? "") + (match.loaded ? " [loaded]" : ""));
  if (data.missing?.length) lines.push("Missing: " + data.missing.join(", "));
  return lines.join("\n");
}

function toolResultText(result: McpToolCallResult): string {
  const text = (result.content ?? [])
    .flatMap((content) => content.type === "text" && typeof content.text === "string" ? [content.text] : [])
    .join("\n");
  if (text) return text;
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}

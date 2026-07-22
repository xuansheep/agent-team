import { isToolExplicitlyDenied } from "../harness/permissions.js";
import type { Tool } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { McpServerStatus, RuntimeMcpTool } from "./runtime.js";
import type { McpToolCallResult } from "./types.js";

const MAX_MCP_TEXT_LENGTH = 2048;

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
  kind: "mcp_tool_search";
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
    const key = tools.map((tool) => [tool.name, sanitizedText(tool.description) ?? "", searchHint(tool)].join("\u0000")).sort().join("\u0001");
    if (cachedRevision === revision && cachedKey === key) return cachedCandidates;
    cachedRevision = revision;
    cachedKey = key;
    cachedCandidates = tools.map((tool) => {
      const parsed = parseToolName(tool.name);
      return {
        tool,
        parts: parsed.parts,
        full: parsed.full,
        description: (sanitizedText(tool.description) ?? "").toLowerCase(),
        hint: searchHint(tool).toLowerCase()
      };
    });
    return cachedCandidates;
  };

  return {
    name: "ToolSearch",
    description: "Load deferred MCP tool schemas before use. Use select:ToolA,ToolB for exact names, an MCP prefix, keywords, or +required terms.",
    prompt: () => [
      "MCP tools may be deferred: the model can see their names but not their schemas.",
      "You MUST call ToolSearch before using any name from <available-deferred-tools>.",
      "Prefer exact lookup with select:mcp__server__tool when the required name is known.",
      "After ToolSearch returns a match, use that exact tool name in the next step.",
      "If an appropriate MCP browser or domain tool is available, do not launch a replacement process unless discovery or the server reports failure.",
      ...(runtime.getServerInstructions?.().map((value) => sanitizedText(value)).filter((value): value is string => Boolean(value)) ?? [])
    ].join("\n\n"),
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
      const allCandidates = candidates().filter((candidate) => !isDenied(candidate.tool.name, context.toolPermissionContext));
      if (context.toolRegistry) {
        for (const name of context.toolRegistry.names()) {
          if (name.startsWith("mcp__") && isDenied(name, context.toolPermissionContext)) context.toolRegistry.remove(name);
        }
      }
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
          ...(item.description ? { description: sanitizedText(item.description) } : {}),
          source: item.source,
          loaded: item.source === "local" || Boolean(context.toolRegistry?.has(item.name))
        });
      }

      const pending = matches.length === 0
        ? runtime.listServerStatuses?.().filter((status) => status.state === "pending").map((status) => status.name)
        : undefined;
      const data: McpToolSearchData = {
        kind: "mcp_tool_search",
        query: value.query,
        matches,
        total_deferred_tools: deferred.length,
        ...(pending?.length ? { pending_mcp_servers: pending } : {}),
        ...(missing.length ? { missing } : {})
      };
      return { output: formatSearchOutput(data), data };
    },
    mapToolResultToModelResult(result, context) {
      const data = result.data as McpToolSearchData | undefined;
      if (!data?.matches?.length) return data ?? result.output ?? result.error;
      if (context?.provider?.deferredToolProtocol?.(context.model ?? "") === "anthropic-tool-reference") {
        return data.matches.map((match) => ({ type: "tool_reference", tool_name: match.name }));
      }
      return data;
    }
  };
}

export function syncMcpRegistry(registry: ToolRegistry, runtime: McpToolSearchRuntime): void {
  const available = new Map(runtime.listTools().map((tool) => [tool.name, tool]));
  for (const name of registry.names()) {
    if (!name.startsWith("mcp__")) continue;
    const tool = available.get(name);
    if (!tool) {
      registry.remove(name);
      continue;
    }
    if (runtime.callTool) {
      registry.remove(name);
      registry.add(createDeferredMcpTool(tool, { callTool: runtime.callTool.bind(runtime) }));
    }
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
    description: sanitizedText(tool.description) ?? "MCP tool " + tool.originalName + " from " + tool.server,
    input_schema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    isReadOnly: () => tool.annotations?.readOnlyHint === true,
    isDestructive: () => tool.annotations?.destructiveHint === true,
    isConcurrencySafe: () => tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true,
    async execute(input) {
      const data = await runtime.callTool(tool.server, tool.originalName, input ?? {});
      const output = toolResultText(data);
      return { output, ...(data.isError ? { error: output, is_error: true } : {}), data };
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
  if (!select && requested.length !== 1) return undefined;

  const matches: Array<{ name: string; description?: string; source: "local" | "mcp" }> = [];
  const missing: string[] = [];
  for (const requestedName of requested) {
    const candidate = candidates.find((entry) => entry.tool.name.toLowerCase() === requestedName.toLowerCase());
    if (candidate) {
      if (!matches.some((entry) => entry.name === candidate.tool.name)) {
        matches.push({ name: candidate.tool.name, description: sanitizedText(candidate.tool.description), source: "mcp" });
      }
      continue;
    }
    const local = registry?.names().find((name) => name.toLowerCase() === requestedName.toLowerCase() && !name.startsWith("mcp__"));
    if (local) {
      const tool = registry?.get(local);
      matches.push({ name: local, description: sanitizedText(tool?.description), source: "local" });
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
      .map((candidate) => ({ name: candidate.tool.name, description: sanitizedText(candidate.tool.description), source: "mcp" as const }));
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
      description: sanitizedText(candidate.tool.description),
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
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

function searchHint(tool: RuntimeMcpTool): string {
  const hint = tool._meta?.["anthropic/searchHint"];
  return typeof hint === "string" ? sanitizedText(hint) ?? "" : "";
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
  const lines = data.matches.map((match) => match.name);
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

function sanitizedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!sanitized) return undefined;
  return sanitized.length <= MAX_MCP_TEXT_LENGTH ? sanitized : sanitized.slice(0, MAX_MCP_TEXT_LENGTH - 1) + "…";
}

function isDenied(name: string, permissions: { deny: string[] } | undefined): boolean {
  return permissions ? isToolExplicitlyDenied(name, permissions) : false;
}

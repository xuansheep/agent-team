import { isToolExplicitlyDenied } from "../harness/permissions.js";
import { isHumanUserMessage } from "../context/messages.js";
import type { ToolPermissionCheckContext } from "../permissions/context.js";
import type { ModelMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createDeferredMcpTool, mcpToolAlwaysLoad, syncMcpRegistry, type McpToolSearchRuntime } from "./deferredTools.js";

export const MCP_DISCOVERY_RESULT_KIND = "mcp_tool_search";
export const MCP_CATALOG_ATTACHMENT_TYPE = "mcp_catalog";

export type McpDiscoverySnapshot = {
  revision: number;
  deferredToolNames: string[];
  deferredTools: import("../tools/types.js").Tool[];
  discoveredToolNames: string[];
  pendingServers: string[];
  failedServers: Array<{ name: string; error?: string }>;
};

export function prepareMcpDiscovery(input: {
  runtime: McpToolSearchRuntime;
  registry: ToolRegistry;
  messages: readonly ModelMessage[];
  permissions?: Pick<ToolPermissionCheckContext, "deny">;
}): McpDiscoverySnapshot {
  syncMcpRegistry(input.registry, input.runtime);
  const available = new Map(
    input.runtime.listTools()
      .filter((tool) => !isDenied(tool.name, input.permissions))
      .map((tool) => [tool.name, tool])
  );
  const discoveredToolNames = extractDiscoveredMcpTools(input.messages)
    .filter((name) => available.has(name))
    .sort((left, right) => left.localeCompare(right));

  if (input.runtime.callTool) {
    for (const name of discoveredToolNames) {
      if (input.registry.has(name)) continue;
      const tool = available.get(name);
      if (tool) input.registry.add(createDeferredMcpTool(tool, { callTool: input.runtime.callTool.bind(input.runtime) }));
    }
  }

  for (const name of input.registry.names()) {
    if (!name.startsWith("mcp__") || !isDenied(name, input.permissions)) continue;
    input.registry.remove(name);
  }

  const deferredMcpTools = [...available.values()]
    .filter((tool) => !mcpToolAlwaysLoad(tool) && !discoveredToolNames.includes(tool.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const deferredToolNames = deferredMcpTools.map((tool) => tool.name);
  const deferredTools = input.runtime.callTool
    ? deferredMcpTools.map((tool) => createDeferredMcpTool(tool, { callTool: input.runtime.callTool!.bind(input.runtime) }))
    : [];
  const statuses = input.runtime.listServerStatuses?.() ?? [];
  return {
    revision: input.runtime.getCatalogRevision?.() ?? 0,
    deferredToolNames,
    deferredTools,
    discoveredToolNames,
    pendingServers: statuses.filter((status) => status.state === "pending").map((status) => status.name).sort(),
    failedServers: statuses
      .filter((status) => status.state === "failed")
      .map((status) => ({ name: status.name, ...(status.error ? { error: sanitizeMcpText(status.error) } : {}) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

export function withMcpCatalogMessage(messages: readonly ModelMessage[], snapshot: McpDiscoverySnapshot): ModelMessage[] {
  const content = formatMcpCatalog(snapshot);
  if (!content) return [...messages];
  const catalogMessage: ModelMessage = {
    role: "system",
    content,
    metadata: {
      runtimeAttachment: {
        type: MCP_CATALOG_ATTACHMENT_TYPE,
        humanTurnCount: countHumanTurns(messages)
      }
    }
  };
  const next = [...messages];
  const firstNonSystem = next.findIndex((message) => message.role !== "system");
  next.splice(firstNonSystem < 0 ? next.length : firstNonSystem, 0, catalogMessage);
  return next;
}

export function extractDiscoveredMcpTools(messages: readonly ModelMessage[]): string[] {
  const discovered = new Set<string>();
  const toolSearchCallIds = new Set<string>();

  for (const message of messages) {
    for (const name of message.metadata?.mcpDiscovery?.preCompactDiscoveredTools ?? []) addMcpName(discovered, name);
    for (const name of message.metadata?.mcpDiscovery?.discoveredTools ?? []) addMcpName(discovered, name);
    if (message.metadata?.compactSummary && typeof message.content === "string") {
      for (const match of message.content.matchAll(/\bmcp__[A-Za-z0-9_]+(?:__[A-Za-z0-9_]+)+\b/g)) {
        addMcpName(discovered, match[0]);
      }
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (call.name === "ToolSearch") toolSearchCallIds.add(call.id);
      }
      continue;
    }
    if (message.role !== "tool" || !message.tool_call_id || !toolSearchCallIds.has(message.tool_call_id)) continue;
    for (const name of parseToolSearchContent(message.content)) addMcpName(discovered, name);
  }

  return [...discovered];
}

export function discoveredToolsMetadata(result: unknown): ModelMessage["metadata"] | undefined {
  const names = toolSearchNames(result);
  return names.length ? { mcpDiscovery: { discoveredTools: names } } : undefined;
}

export function mergePreCompactDiscoveredTools(
  summaryMessage: ModelMessage,
  sourceMessages: readonly ModelMessage[]
): ModelMessage {
  const names = extractDiscoveredMcpTools(sourceMessages).sort((left, right) => left.localeCompare(right));
  if (!names.length) return summaryMessage;
  return {
    ...summaryMessage,
    metadata: {
      ...summaryMessage.metadata,
      mcpDiscovery: {
        ...summaryMessage.metadata?.mcpDiscovery,
        preCompactDiscoveredTools: names
      }
    }
  };
}

function formatMcpCatalog(snapshot: McpDiscoverySnapshot): string {
  const sections: string[] = [];
  if (snapshot.deferredToolNames.length) {
    sections.push(`<available-deferred-tools>\n${snapshot.deferredToolNames.join("\n")}\n</available-deferred-tools>`);
  }
  if (snapshot.pendingServers.length || snapshot.failedServers.length) {
    const lines = [
      ...snapshot.pendingServers.map((name) => `${name}: pending`),
      ...snapshot.failedServers.map((server) => `${server.name}: failed${server.error ? ` - ${server.error}` : ""}`)
    ];
    sections.push(`<mcp-server-status>\n${lines.join("\n")}\n</mcp-server-status>`);
  }
  if (!sections.length) return "";
  return [
    "MCP tools listed below are deferred. Their names are available, but their schemas are not loaded.",
    "Call ToolSearch with an exact query such as select:mcp__server__tool before attempting to use a deferred tool.",
    "Do not replace an available MCP browser or domain tool with a shell-launched process unless ToolSearch or that MCP server reports failure.",
    ...sections
  ].join("\n\n");
}

function parseToolSearchContent(content: ModelMessage["content"]): string[] {
  if (typeof content !== "string") return content.flatMap((part) => part.type === "tool_reference" ? [part.tool_name] : []);
  try {
    return toolSearchNames(JSON.parse(content));
  } catch {
    return [...content.matchAll(/\bmcp__[A-Za-z0-9_]+(?:__[A-Za-z0-9_]+)+\b/g)].map((match) => match[0]);
  }
}

function toolSearchNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : record;
  if (data.kind !== MCP_DISCOVERY_RESULT_KIND && !Array.isArray(data.matches)) return [];
  const names = Array.isArray(data.matches)
    ? data.matches.flatMap((match) => {
      if (typeof match === "string") return [match];
      if (!match || typeof match !== "object" || Array.isArray(match)) return [];
      const name = (match as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    })
    : [];
  return [...new Set(names.filter((name) => name.startsWith("mcp__")))];
}

function isDenied(name: string, permissions: Pick<ToolPermissionCheckContext, "deny"> | undefined): boolean {
  return permissions ? isToolExplicitlyDenied(name, permissions) : false;
}

function addMcpName(target: Set<string>, name: string): void {
  if (name.startsWith("mcp__")) target.add(name);
}

function countHumanTurns(messages: readonly ModelMessage[]): number {
  return messages.filter(isHumanUserMessage).length;
}

export function sanitizeMcpText(value: string | undefined, maxLength = 2048): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!sanitized) return undefined;
  return sanitized.length <= maxLength ? sanitized : sanitized.slice(0, maxLength - 1) + "…";
}

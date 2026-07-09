import type { McpRuntimeDiagnostic, McpToolDiagnostic } from "../../mcp/runtime.js";
import type { InteractionChoice } from "../components/InteractionArea.js";

export type McpMenuAction = "enable" | "disable" | "reconnect";

export function buildMcpListChoice(input: { servers: McpRuntimeDiagnostic[]; onSelect: (server: string) => void; onAction: (action: McpMenuAction, server?: string) => void; onCancel: () => void }): InteractionChoice {
  const options = input.servers.map((server) => ({ label: server.name, value: server.name, description: serverSummary(server) }));
  return {
    title: "MCP Servers",
    detail: input.servers.length ? `${input.servers.length} visible servers` : "No MCP servers configured",
    options: options.length ? options : [{ label: "No MCP servers", value: "__empty__", disabled: true }],
    selectedValue: options[0]?.value ?? "__empty__",
    visibleOptionCount: 10,
    footerActions: [{ label: "Enable All", value: "__enable_all__" }, { label: "Disable All", value: "__disable_all__" }, { label: "Esc Back", value: "__cancel__" }],
    onCancel: input.onCancel,
    onSubmit: (value) => {
      if (value === "__enable_all__") input.onAction("enable");
      else if (value === "__disable_all__") input.onAction("disable");
      else if (value === "__cancel__") input.onCancel();
      else if (value !== "__empty__") input.onSelect(value);
    }
  };
}

export function buildMcpServerChoice(input: { server: McpRuntimeDiagnostic; tools: McpToolDiagnostic[]; onSelectTools: () => void; onAction: (action: McpMenuAction, server: string) => void; onBack: () => void; onCancel: () => void }): InteractionChoice {
  const toggle = input.server.state === "disabled" ? "Enable" : "Disable";
  return {
    title: `MCP: ${input.server.name}`,
    documentBlock: { text: serverDetailText(input.server), maxLines: 14, scrollable: true },
    options: [
      { label: "Tools", value: "__tools__", description: `${input.tools.length} tools` },
      { label: "Reconnect", value: "__reconnect__" },
      { label: toggle, value: toggle === "Enable" ? "__enable__" : "__disable__" },
      { label: "Back", value: "__back__" }
    ],
    selectedValue: "__tools__",
    footerActions: [{ label: "Esc Back", value: "__back__" }],
    onCancel: input.onBack,
    onSubmit: (value) => {
      if (value === "__tools__") input.onSelectTools();
      else if (value === "__reconnect__") input.onAction("reconnect", input.server.name);
      else if (value === "__enable__") input.onAction("enable", input.server.name);
      else if (value === "__disable__") input.onAction("disable", input.server.name);
      else input.onBack();
    }
  };
}

export function buildMcpToolsChoice(input: { server: string; tools: McpToolDiagnostic[]; onSelect: (name: string) => void; onBack: () => void; onCancel: () => void }): InteractionChoice {
  const options = input.tools.map((tool) => ({ label: tool.originalName, value: tool.name, description: tool.description ?? tool.name }));
  return {
    title: `MCP Tools: ${input.server}`,
    detail: options.length ? `${options.length} tools` : "No tools exposed",
    options: options.length ? options : [{ label: "No tools", value: "__empty__", disabled: true }],
    selectedValue: options[0]?.value ?? "__empty__",
    visibleOptionCount: 10,
    footerActions: [{ label: "Esc Back", value: "__back__" }],
    onCancel: input.onBack,
    onSubmit: (value) => value === "__back__" || value === "__empty__" ? input.onBack() : input.onSelect(value)
  };
}

export function buildMcpToolDetailChoice(input: { tool: McpToolDiagnostic; onBack: () => void; onCancel: () => void }): InteractionChoice {
  return {
    title: `MCP Tool: ${input.tool.originalName}`,
    documentBlock: { text: toolDetailText(input.tool), maxLines: 18, scrollable: true },
    options: [{ label: "Back", value: "__back__" }],
    selectedValue: "__back__",
    footerActions: [{ label: "Esc Back", value: "__back__" }],
    onCancel: input.onBack,
    onSubmit: input.onBack
  };
}

function serverSummary(server: McpRuntimeDiagnostic): string {
  return [server.state, server.source, server.transport, `tools=${server.toolCount}`, `resources=${server.resourceCount}`, `prompts=${server.promptCount}`, server.error].filter(Boolean).join(" · ");
}

function serverDetailText(server: McpRuntimeDiagnostic): string {
  return [
    `name: ${server.name}`,
    `state: ${server.state}`,
    `source: ${server.source}`,
    server.sourcePath ? `sourcePath: ${server.sourcePath}` : undefined,
    server.sourceFormat ? `sourceFormat: ${server.sourceFormat}` : undefined,
    `transport: ${server.transport}`,
    `disabled: ${server.disabled === true}`,
    `tools: ${server.toolCount}`,
    `resources: ${server.resourceCount}`,
    `prompts: ${server.promptCount}`,
    server.error ? `error: ${server.error}` : undefined
  ].filter(Boolean).join("\n");
}

function toolDetailText(tool: McpToolDiagnostic): string {
  return [
    `name: ${tool.name}`,
    `originalName: ${tool.originalName}`,
    `server: ${tool.server}`,
    tool.description ? `description: ${tool.description}` : undefined,
    `inputSchema:\n${JSON.stringify(tool.inputSchema ?? {}, null, 2)}`
  ].filter(Boolean).join("\n");
}

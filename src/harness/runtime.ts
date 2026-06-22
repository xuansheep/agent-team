import { randomUUID } from "node:crypto";
import { PermissionSet, WorkflowNodeConfig } from "../config/schema.js";
import { ModelProvider } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { RunStore } from "../storage/runStore.js";
import { buildNodeMessages } from "./context.js";
import { decidePermission } from "./permissions.js";
import { NodeResult, parseNodeResult } from "../team/nodeResult.js";
import { PermissionDecision, PermissionRequest } from "./permissionController.js";

export type RuntimeInteraction = {
  requestPermission?(request: PermissionRequest): Promise<PermissionDecision>;
};

export type NodeRuntimeOptions = {
  node: WorkflowNodeConfig;
  systemPrompt: string;
  model: string;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: PermissionSet;
  cwd: string;
  runId: string;
  store: RunStore;
  handoff: unknown;
  attempt?: number;
  interaction?: RuntimeInteraction;
};

export async function runNode(options: NodeRuntimeOptions): Promise<NodeResult> {
  const messages = await buildNodeMessages(options.node, options.systemPrompt, options.handoff);
  const attempt = options.attempt ?? 1;

  for (;;) {
    const response = await options.provider.generate({ model: options.model, messages, tools: options.tools.list() });

    if (response.tool_calls?.length) {
      for (const call of response.tool_calls) {
        const specifier = toolSpecifier(call.name, call.input);
        const permission = decidePermission(call.name, specifier, options.permissions);
        if (permission.decision === "deny") {
          const error = `Permission denied for ${call.name}: ${permission.rule ?? "no rule"}`;
          await options.store.appendEvent(options.runId, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
          throw new Error(error);
        }
        if (permission.decision === "ask") {
          if (!options.interaction?.requestPermission) {
            const error = `Permission ask is not interactive in this MVP for ${call.name}`;
            await options.store.appendEvent(options.runId, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
            throw new Error(error);
          }

          const requestId = randomUUID();
          const request = {
            requestId,
            nodeId: options.node.id,
            attempt,
            toolCallId: call.id,
            tool: call.name,
            input: call.input,
            specifier,
            rule: permission.rule
          };
          await options.store.appendEvent(options.runId, {
            type: "permission_requested",
            request_id: requestId,
            node_id: options.node.id,
            attempt,
            tool_call_id: call.id,
            tool: call.name,
            input: call.input,
            rule: permission.rule,
            specifier
          });
          const decision = await options.interaction.requestPermission(request);
          await options.store.appendEvent(options.runId, {
            type: "permission_resolved",
            request_id: requestId,
            node_id: options.node.id,
            attempt,
            tool_call_id: call.id,
            decision
          });
          if (decision === "deny_once") {
            const error = `Permission denied by user for ${call.name}`;
            await options.store.appendEvent(options.runId, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error }) });
            continue;
          }
        }

        await options.store.appendEvent(options.runId, { type: "tool_invoked", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, input: call.input });
        try {
          const tool = options.tools.get(call.name);
          const result = await tool.execute(call.input, { cwd: options.cwd, runDir: options.store.runDir(options.runId) });
          await options.store.appendEvent(options.runId, { type: "tool_completed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, result });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await options.store.appendEvent(options.runId, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error: message });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) });
        }
      }
      continue;
    }

    if (!response.content) throw new Error(`Node ${options.node.id} returned no content and no tool calls`);
    return parseNodeResult(response.content);
  }
}

function toolSpecifier(tool: string, input: unknown): string {
  const value = input as Record<string, unknown>;
  if (tool === "Bash" || tool === "PowerShell") return String(value.command ?? "");
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.path === "string") return value.path;
  if (typeof value.url === "string") return value.url;
  return "";
}

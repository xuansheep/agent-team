import { resolveMcpInvokeCall } from "../mcp/deferredTools.js";
import { ModelToolCall } from "../providers/types.js";
import { executeTool, toolFailureResult } from "./errors.js";
import { ToolRegistry } from "./registry.js";
import { ToolContext, ToolResult } from "./types.js";

export type ToolCallExecution = {
  call: ModelToolCall;
  result?: ToolResult;
  failure?: ToolResult;
  error?: string;
};

export type ResolvedToolCall = ModelToolCall & { via?: string };

export type ToolCallExecutionHooks = {
  onToolStart?: (call: ResolvedToolCall) => void | Promise<void>;
  onToolComplete?: (call: ResolvedToolCall, result: ToolResult) => void | Promise<void>;
  onToolError?: (call: ResolvedToolCall, error: string, failure?: ToolResult) => void | Promise<void>;
};

export function resolveToolCall(call: ModelToolCall): ResolvedToolCall {
  if (call.name !== "McpInvoke") return call;
  try {
    const resolved = resolveMcpInvokeCall(call.input);
    return { ...call, name: resolved.name, input: resolved.input, via: call.name };
  } catch {
    return call;
  }
}

export async function executeToolCalls(
  calls: ModelToolCall[],
  registry: ToolRegistry,
  context: ToolContext,
  hooks: ToolCallExecutionHooks = {}
): Promise<ToolCallExecution[]> {
  const results: ToolCallExecution[] = [];
  for (let index = 0; index < calls.length;) {
    const call = calls[index];
    if (await requiresUserInteraction(call, registry)) {
      results.push(await executeOne(call, registry, context, hooks));
      break;
    }

    const group = await nextConcurrencySafeGroup(calls, index, registry);
    if (group.length > 0) {
      results.push(...await Promise.all(group.map((item) => executeOne(item, registry, context, hooks))));
      index += group.length;
      continue;
    }

    results.push(await executeOne(call, registry, context, hooks));
    index += 1;
  }
  return results;
}

async function nextConcurrencySafeGroup(calls: ModelToolCall[], start: number, registry: ToolRegistry): Promise<ModelToolCall[]> {
  const group: ModelToolCall[] = [];
  for (let index = start; index < calls.length; index += 1) {
    const tool = registry.has(calls[index].name) ? registry.get(calls[index].name) : undefined;
    if (!tool || await tool.requiresUserInteraction?.(calls[index].input)) break;
    if (!tool.isConcurrencySafe?.()) break;
    group.push(calls[index]);
  }
  return group.length > 1 ? group : [];
}

async function requiresUserInteraction(call: ModelToolCall, registry: ToolRegistry): Promise<boolean> {
  if (!registry.has(call.name)) return false;
  return await registry.get(call.name).requiresUserInteraction?.(call.input) === true;
}

async function executeOne(
  call: ModelToolCall,
  registry: ToolRegistry,
  context: ToolContext,
  hooks: ToolCallExecutionHooks
): Promise<ToolCallExecution> {
  const reportedCall = resolveToolCall(call);
  await context.auditSink?.({
    type: "tool_invocation",
    session_id: context.sessionId,
    run_id: context.runId,
    node_id: context.nodeId,
    attempt: context.attempt,
    tool: reportedCall.name,
    input: reportedCall.input,
    ...(reportedCall.via ? { via: reportedCall.via } : {})
  });
  await hooks.onToolStart?.(reportedCall);
  try {
    if (!registry.has(call.name)) throw new Error(`No such tool available: ${call.name}`);
    const result = await executeTool(registry.get(call.name), call.input, context);
    await context.auditSink?.({
      type: "tool_result",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: reportedCall.name,
      ...(reportedCall.via ? { via: reportedCall.via } : {}),
      status: "completed",
      result
    });
    await hooks.onToolComplete?.(reportedCall, result);
    return { call, result };
  } catch (error) {
    const failure = toolFailureResult(error);
    const message = failure.error ?? "Tool failed";
    await context.auditSink?.({
      type: "tool_result",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: reportedCall.name,
      ...(reportedCall.via ? { via: reportedCall.via } : {}),
      status: "failed",
      error: message,
      result: failure
    });
    await hooks.onToolError?.(reportedCall, message, failure);
    return { call, error: message, failure };
  }
}

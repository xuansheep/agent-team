import { createHash, randomUUID } from "node:crypto";
import { PermissionSet, WorkflowNodeConfig } from "../config/schema.js";
import { ModelMessage, ModelProvider, ModelResponse, ModelToolCall } from "../providers/types.js";
import { skillActivationFromToolResult, skillPermissionRulesFromToolResult, skillRuntimeOverridesFromToolResult, skillSystemMessageFromToolResult } from "../skills/skillTools.js";
import { hasModelUsage } from "../model/usage.js";
import { executeTool, toolFailureResult } from "../tools/errors.js";
import { ToolRegistry } from "../tools/registry.js";
import { Tool, ToolResult } from "../tools/types.js";
import { RunStore } from "../storage/runStore.js";
import { buildNodeMessages } from "./context.js";
import { NodeResult, nodeResultJsonSchema, nodeResultSchema, parseNodeResult, visibleAssistantTextBeforeNodeResult } from "../team/nodeResult.js";
import { PermissionDecision, PermissionRequest } from "./permissionController.js";
import { HarnessEvent, StoredEvent } from "./events.js";
import { RuntimeTurnExecutor } from "../runtime/turnExecutor.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import { checkToolPermission } from "../permissions/checkToolPermission.js";
import type { NodeNavigation } from "../workflow/nodeTransitionController.js";
export type RuntimeInteraction = {
  requestPermission?(request: PermissionRequest): Promise<PermissionDecision>;
};
export type NodeRuntimeOptions = {
  node: WorkflowNodeConfig;
  systemPrompt: string;
  model: string;
  effort?: string | number;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: ToolPermissionContext | PermissionSet;
  cwd: string;
  runId: string;
  store: RunStore;
  handoff: unknown;
  navigation?: NodeNavigation;
  attempt?: number;
  activation?: number;
  dialogueMessages?: ModelMessage[];
  onDialogueMessages?: (messages: ModelMessage[]) => Promise<void> | void;
  interaction?: RuntimeInteraction;
  eventSink?: (event: StoredEvent) => void;
  abortSignal?: AbortSignal;
};
export async function runNode(options: NodeRuntimeOptions): Promise<NodeResult> {
  options.abortSignal?.throwIfAborted();
  const attempt = options.attempt ?? 1;
  const artifactDeliverables: NodeResult["deliverables"] = [];
  let requestTools = [...options.tools.list(), submitNodeResultTool];
  const runtimePermissions = normalizeRuntimePermissions(options.permissions);
  await restoreSkillPermissions(options, runtimePermissions, attempt);
  const baseMessages = await buildNodeMessages(options.node, options.systemPrompt, options.handoff, {
    tools: requestTools,
    permissionMode: runtimePermissions.mode,
    navigation: options.navigation,
    runDir: options.store.runDir(options.runId),
    onArtifactRead: async (chunk) => { await appendRuntimeEvent(options, {
      type: "artifact_read",
      node_id: options.node.id,
      attempt,
      artifact_id: chunk.artifact_id,
      offset: chunk.offset,
      bytes_read: Buffer.byteLength(chunk.content, "utf8"),
      total_bytes: chunk.total_bytes,
      truncated: chunk.truncated,
      source: "handoff"
    }); }
  });
  const messages: ModelMessage[] = [...baseMessages, ...(options.dialogueMessages ?? [])];
  const baseMessageCount = baseMessages.length;
  const turnExecutor = new RuntimeTurnExecutor();
  let resultRepairAttempts = 0;
  let toolPreambleRepairAttempts = 0;
  const persistDialogueMessages = async () => {
    await options.onDialogueMessages?.(messages.slice(baseMessageCount));
  };
  const appendDialogueMessage = async (message: ModelMessage) => {
    messages.push(message);
    await persistDialogueMessages();
  };
  if (await reconcileInterruptedToolCalls(options, attempt, messages, artifactDeliverables)) await persistDialogueMessages();
  for (;;) {
    options.abortSignal?.throwIfAborted();
    assertResolvedToolCallHistory(messages);
    requestTools = [...options.tools.list(), submitNodeResultTool];
    const request = {
      model: options.model,
      effort: options.effort,
      messages: messages.slice(),
      tools: requestTools,
      response_schema: requestTools.length ? undefined : nodeResultJsonSchema,
      signal: options.abortSignal,
      context: {
        runId: options.runId,
        nodeId: options.node.id,
        attempt,
        sessionId: options.runId,
        threadId: `${options.runId}:${options.node.id}`,
        turnId: `${options.runId}:${options.node.id}:${attempt}`,
        promptCacheKey: promptCacheKey(options.runId, options.node.id)
      }
    };
    let streamEventWrites: Promise<unknown> = Promise.resolve();
    const { streamed, response } = await turnExecutor.requestModel({
      provider: options.provider,
      request,
      onStreamEvent(event) {
        streamEventWrites = streamEventWrites.then(() => appendRuntimeEvent(options, {
          type: event.type === "thinking_delta" ? "model_thinking_delta" : "model_stream_delta",
          node_id: options.node.id,
          attempt,
          text: event.text
        }));
      }
    });
    await streamEventWrites;
    options.abortSignal?.throwIfAborted();
    await appendModelUsageEvent(options, attempt, options.model, response);
    if (!streamed) await appendNonStreamingResponseEvents(options, attempt, response);
    if (response.tool_calls?.length) {
      const submittedResult = response.tool_calls.find((call) => call.name === submitNodeResultTool.name);
      if (submittedResult) {
        await appendDialogueMessage({ role: "assistant", content: assistantToolCallContent(response.content), tool_calls: [submittedResult] });
        await appendDialogueMessage(submitNodeResultToolMessage(submittedResult.id));
        return mergeArtifactDeliverables(nodeResultSchema.parse(submittedResult.input), artifactDeliverables);
      }
      const assistantContent = assistantToolCallContent(response.content);
      if (!assistantContent.trim() && shouldRepairToolPreamble(response.content) && toolPreambleRepairAttempts < 1) {
        toolPreambleRepairAttempts += 1;
        await appendDialogueMessage({ role: "user", content: toolPreambleRepairPrompt(response.content, response.tool_calls) });
        continue;
      }
      await appendDialogueMessage({ role: "assistant", content: assistantContent, tool_calls: response.tool_calls });
      for (const call of response.tool_calls) {
        options.abortSignal?.throwIfAborted();
        options.tools.activateSkillsForInput(call.input, options.cwd);
        const specifier = toolSpecifier(call.name, call.input);
        if (!options.tools.has(call.name)) {
          const failure: ToolResult = { is_error: true, error: `Unknown tool ${call.name}` };
          await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error: failure.error!, result: failure });
          await appendDialogueMessage({ role: "tool", tool_call_id: call.id, is_error: true, content: JSON.stringify(failure) });
          continue;
        }
        const tool = options.tools.get(call.name);
        const permission = await checkToolPermission(tool, call.input, { ...runtimePermissions, cwd: options.cwd });
        if (permission.decision === "deny") {
          const error = `Permission denied for ${call.name}: ${permission.reason ?? permission.rule ?? "no rule"}`;
          await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error });
          throw new Error(error);
        }
        if (permission.decision === "ask") {
          if (!options.interaction?.requestPermission) {
            const error = `Permission ask is not interactive in this MVP for ${call.name}`;
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error });
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
          await appendRuntimeEvent(options, {
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
          await appendRuntimeEvent(options, {
            type: "permission_resolved",
            request_id: requestId,
            node_id: options.node.id,
            attempt,
            tool_call_id: call.id,
            decision
          });
          options.abortSignal?.throwIfAborted();
          if (decision === "deny_once") {
            const error = `Permission denied by user for ${call.name}`;
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error });
            await appendDialogueMessage({ role: "tool", tool_call_id: call.id, is_error: true, content: JSON.stringify({ is_error: true, error }) });
            continue;
          }
        }
        options.abortSignal?.throwIfAborted();
        await assertToolCallCanExecute(options, attempt, call, tool);
        await appendRuntimeEvent(options, { type: "tool_invoked", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, input: call.input });
        try {
          const result = await executeTool(tool, call.input, { cwd: options.cwd, runDir: options.store.runDir(options.runId), nodeId: options.node.id, attempt, activation: options.activation ?? 1, runId: options.runId, provider: options.provider, model: options.model, toolRegistry: options.tools, permissionMode: runtimePermissions.mode, planFilePath: runtimePermissions.planFilePath, abortSignal: options.abortSignal });
          await appendRuntimeEvent(options, { type: "tool_completed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, result });
          const artifact = artifactFromToolResult(result);
          if (artifact) {
            await appendRuntimeEvent(options, { type: "artifact_created", node_id: options.node.id, artifact_id: artifact.artifact_id, path: artifact.path });
            if (!artifactDeliverables.some((item) => item.artifact_id === artifact.artifact_id)) {
              artifactDeliverables.push({ artifact_id: artifact.artifact_id, description: artifact.description });
            }
          }
          const artifactRead = artifactReadFromToolResult(call.name, result);
          if (artifactRead) {
            await appendRuntimeEvent(options, { type: "artifact_read", node_id: options.node.id, attempt, source: "tool", ...artifactRead });
          }
          const skillActivation = skillActivationFromToolResult(result);
          if (skillActivation) {
            applySkillPermissionRules(runtimePermissions, skillPermissionRulesFromToolResult(result));
            await appendRuntimeEvent(options, {
              type: "skill_activated",
              node_id: options.node.id,
              attempt,
              activation: options.activation,
              name: skillActivation.name,
              mode: skillActivation.mode,
              source: skillActivation.source,
              version: skillActivation.version,
              allowed_tools: skillActivation.allowedTools
            });
          }
          await appendDialogueMessage({ role: "tool", tool_call_id: call.id, ...(result.is_error === true ? { is_error: true } : {}), content: JSON.stringify(result) });
          const skillMessage = skillSystemMessageFromToolResult(result);
          if (skillMessage) await appendDialogueMessage(skillMessage);
          const skillOverrides = skillRuntimeOverridesFromToolResult(result);
          if (skillOverrides?.model) options.model = skillOverrides.model;
          if (skillOverrides?.effort !== undefined) options.effort = skillOverrides.effort;
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          const failure = toolFailureResult(error);
            const message = failure.error ?? "Tool failed";
          await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error: message, result: failure });
          await appendDialogueMessage({ role: "tool", tool_call_id: call.id, is_error: true, content: JSON.stringify(failure) });
        }
      }
      continue;
    }
    if (!response.content) throw new Error(`Node ${options.node.id} returned no content and no tool calls`);
    try {
      const result = mergeArtifactDeliverables(parseNodeResult(response.content), artifactDeliverables);
      await appendDialogueMessage({ role: "assistant", content: response.content });
      return result;
    } catch (error) {
      if (resultRepairAttempts >= 1) throw new Error(`Invalid NodeResult after repair attempt: ${errorMessage(error)}`, { cause: error });
      resultRepairAttempts += 1;
      await appendDialogueMessage({ role: "assistant", content: response.content });
      await appendDialogueMessage({ role: "user", content: nodeResultRepairPrompt(error) });
      continue;
    }
  }
}
const submitNodeResultTool: Tool = {
  name: "SubmitNodeResult",
  description: "Submit the final NodeResult and explicitly move forward or backward in the ordered workflow.",
  input_schema: nodeResultJsonSchema as unknown as Record<string, unknown>,
  async execute() {
    return { error: "SubmitNodeResult is handled by the runtime", exit_code: 1 };
  }
};
const submittedNodeResultContent = JSON.stringify({ status: "submitted" });

function submitNodeResultToolMessage(toolCallId: string): ModelMessage {
  return { role: "tool", tool_call_id: toolCallId, content: submittedNodeResultContent };
}

function artifactFromToolResult(result: ToolResult): { artifact_id: string; path: string; description: string } | undefined {
  if (!result.artifact_id || !result.path) return undefined;
  return { artifact_id: result.artifact_id, path: result.path, description: result.description ?? "" };
}
function normalizeRuntimePermissions(permissions: ToolPermissionContext | PermissionSet): ToolPermissionContext {
  if ("mode" in permissions) {
    return {
      ...permissions,
      allow: permissions.allow.slice(),
      ask: permissions.ask.slice(),
      deny: permissions.deny.slice(),
      transientAllow: permissions.transientAllow?.slice() ?? []
    };
  }
  return { mode: "default", source: "workflow", allow: permissions.allow.slice(), ask: permissions.ask.slice(), deny: permissions.deny.slice(), transientAllow: [] };
}

async function restoreSkillPermissions(options: NodeRuntimeOptions, permissions: ToolPermissionContext, attempt: number): Promise<void> {
  const activation = options.activation ?? 1;
  const events = await options.store.loadEvents(options.runId);
  const skills = events.filter((event): event is Extract<StoredEvent, { type: "skill_activated" }> =>
    event.type === "skill_activated"
    && event.node_id === options.node.id
    && (event.attempt ?? 1) === attempt
    && (event.activation ?? 1) === activation
  );
  for (const skill of skills) {
    if (skill.mode === "inline") applySkillPermissionRules(permissions, skill.allowed_tools);
  }
  options.tools.skillRuntime?.restoreSession(options.runId, skills.map((skill) => skill.name));
}

function applySkillPermissionRules(permissions: ToolPermissionContext, rules: string[]): void {
  permissions.transientAllow = [...new Set([...(permissions.transientAllow ?? []), ...rules])];
}

function artifactReadFromToolResult(tool: string, result: ToolResult): { artifact_id: string; offset: number; bytes_read: number; total_bytes: number; truncated: boolean } | undefined {
  if (tool !== "ArtifactRead" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return undefined;
  const data = result.data as Record<string, unknown>;
  if (typeof data.artifact_id !== "string" || typeof data.offset !== "number" || typeof data.content !== "string" || typeof data.total_bytes !== "number" || typeof data.truncated !== "boolean") return undefined;
  return { artifact_id: data.artifact_id, offset: data.offset, bytes_read: Buffer.byteLength(data.content, "utf8"), total_bytes: data.total_bytes, truncated: data.truncated };
}

function nodeResultRepairPrompt(error: unknown): string {
  return [
    "The previous response was not a valid final NodeResult.",
    `Validation error: ${errorMessage(error)}`,
    "Return exactly one valid NodeResult JSON object and nothing else.",
    "Do not include multiple JSON objects, Markdown fences, explanations, or revisions.",
    "Use direction backward only when the previous node or the user must respond."
  ].join("\n");
}
function mergeArtifactDeliverables(result: NodeResult, artifacts: NodeResult["deliverables"]): NodeResult {
  if (!artifacts.length) return result;
  const deliverables = [...result.deliverables];
  for (const artifact of artifacts) {
    if (!deliverables.some((item) => item.artifact_id === artifact.artifact_id)) deliverables.push(artifact);
  }
  return { ...result, deliverables };
}
function assistantToolCallContent(content: string | undefined): string {
  return visibleAssistantTextBeforeNodeResult(content ?? "");
}
function shouldRepairToolPreamble(content: string | undefined): boolean {
  return !assistantToolCallContent(content).trim();
}
function toolPreambleRepairPrompt(content: string | undefined, toolCalls: ModelToolCall[]): string {
  return [
    "The previous tool-call turn did not include a user-visible natural-language preamble.",
    "Do not put NodeResult JSON in assistant content before tool calls.",
    "Briefly explain the immediate next action, then resend any non-SubmitNodeResult tool calls that are still needed.",
    `Invalid assistant content excerpt: ${promptExcerpt(content ?? "")}`,
    `Tool calls from the invalid turn: ${promptExcerpt(JSON.stringify(toolCalls))}`
  ].join("\n");
}
function promptExcerpt(text: string): string {
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}
async function appendRuntimeEvent(options: NodeRuntimeOptions, event: HarnessEvent): Promise<StoredEvent> {
  const stored = await options.store.appendEvent(options.runId, event);
  options.eventSink?.(stored);
  return stored;
}
async function appendModelUsageEvent(options: NodeRuntimeOptions, attempt: number, model: string, response: ModelResponse): Promise<void> {
  if (!hasModelUsage(response.usage)) return;
  await appendRuntimeEvent(options, { type: "model_usage_recorded", node_id: options.node.id, attempt, model, usage: response.usage, stop_reason: response.stopReason });
}

async function appendNonStreamingResponseEvents(options: NodeRuntimeOptions, attempt: number, response: { content?: string; thinking?: string }): Promise<void> {
  if (response.thinking) {
    await appendRuntimeEvent(options, { type: "model_thinking_delta", node_id: options.node.id, attempt, text: response.thinking });
  }
  if (response.content) {
    await appendRuntimeEvent(options, { type: "model_stream_delta", node_id: options.node.id, attempt, text: response.content });
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function promptCacheKey(runId: string, nodeId: string): string {
  return createHash("sha256").update(`${runId}:${nodeId}`).digest("hex");
}
function toolSpecifier(tool: string, input: unknown): string {
  const value = input as Record<string, unknown>;
  if (tool === "Bash" || tool === "PowerShell") return String(value.command ?? "");
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.path === "string") return value.path;
  if (typeof value.url === "string") return value.url;
  return "";
}

async function reconcileInterruptedToolCalls(options: NodeRuntimeOptions, attempt: number, messages: ModelMessage[], artifacts: NodeResult["deliverables"]): Promise<boolean> {
  const existingToolResults = new Set(messages.filter((message) => message.role === "tool" && message.tool_call_id).map((message) => message.tool_call_id));
  const events = await options.store.loadEvents(options.runId);
  let changed = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const recovered: ModelMessage[] = [];
    for (const call of message.tool_calls) {
      if (existingToolResults.has(call.id)) continue;
      if (call.name === submitNodeResultTool.name) {
        recovered.push(submitNodeResultToolMessage(call.id));
        existingToolResults.add(call.id);
        continue;
      }
      const ledger = toolCallLedger(events, options.node.id, attempt, options.activation ?? 1, call.id);
      if (ledger.completed) {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(ledger.completed.result) });
        const artifact = artifactFromToolResult(ledger.completed.result as ToolResult);
        if (artifact && !artifacts.some((item) => item.artifact_id === artifact.artifact_id)) artifacts.push({ artifact_id: artifact.artifact_id, description: artifact.description });
      } else if (ledger.failed) {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: ledger.failed.error }) });
      } else if (ledger.invoked) {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Tool execution outcome is unknown after interruption. This call will not be executed again automatically." }) });
      } else {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Tool execution did not start before interruption. Resend the call if it is still required." }) });
      }
      existingToolResults.add(call.id);
    }
    if (recovered.length) {
      messages.splice(index + 1, 0, ...recovered);
      index += recovered.length;
      changed = true;
    }
  }
  return changed;
}

function assertResolvedToolCallHistory(messages: ModelMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const unresolved = new Set(message.tool_calls.map((call) => call.id));
    for (let nextIndex = index + 1; nextIndex < messages.length && unresolved.size; nextIndex += 1) {
      const next = messages[nextIndex];
      if (next.role === "tool" && next.tool_call_id) {
        unresolved.delete(next.tool_call_id);
        continue;
      }
      if (next.role === "user" || next.role === "assistant") break;
    }
    if (unresolved.size) {
      throw new Error(`Invalid model dialogue: unresolved tool calls before the next turn: ${[...unresolved].join(", ")}`);
    }
  }
}

async function assertToolCallCanExecute(options: NodeRuntimeOptions, attempt: number, call: ModelToolCall, tool: Tool): Promise<void> {
  const activation = options.activation ?? 1;
  const events = await options.store.loadEvents(options.runId);
  const sameId = toolCallLedger(events, options.node.id, attempt, activation, call.id);
  if (sameId.completed || sameId.failed || sameId.invoked) throw new Error(`Tool call ${call.id} was already recorded and will not be executed again`);
  const fingerprint = toolInputFingerprint(call.name, call.input);
  const invoked = events.filter((event): event is Extract<StoredEvent, { type: "tool_invoked" }> =>
    event.type === "tool_invoked"
    && event.node_id === options.node.id
    && (event.attempt ?? 1) === attempt
    && (event.activation ?? 1) === activation
    && toolInputFingerprint(event.tool, event.input) === fingerprint
  );
  const inDoubt = invoked.some((event) => {
    const ledger = toolCallLedger(events, options.node.id, attempt, activation, event.tool_call_id ?? "");
    return !ledger.completed && !ledger.failed;
  });
  if (inDoubt && tool.isReadOnly?.(call.input, { cwd: options.cwd, runDir: options.store.runDir(options.runId), nodeId: options.node.id, attempt, activation }) !== true) {
    throw new Error(`Refusing to repeat non-read-only tool ${call.name}: an equivalent call has an unknown outcome after interruption`);
  }
}

function toolCallLedger(events: StoredEvent[], nodeId: string, attempt: number, activation: number, toolCallId: string): {
  invoked?: Extract<StoredEvent, { type: "tool_invoked" }>;
  completed?: Extract<StoredEvent, { type: "tool_completed" }>;
  failed?: Extract<StoredEvent, { type: "tool_failed" }>;
} {
  const relevant = events.filter((event) =>
    (event.type === "tool_invoked" || event.type === "tool_completed" || event.type === "tool_failed")
    && event.node_id === nodeId
    && (event.attempt ?? 1) === attempt
    && (event.activation ?? 1) === activation
    && event.tool_call_id === toolCallId
  );
  const reversed = [...relevant].reverse();
  return {
    invoked: reversed.find((event): event is Extract<StoredEvent, { type: "tool_invoked" }> => event.type === "tool_invoked"),
    completed: reversed.find((event): event is Extract<StoredEvent, { type: "tool_completed" }> => event.type === "tool_completed"),
    failed: reversed.find((event): event is Extract<StoredEvent, { type: "tool_failed" }> => event.type === "tool_failed")
  };
}

function toolInputFingerprint(tool: string, input: unknown): string {
  return createHash("sha256").update(`${tool}:${stableJson(input)}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

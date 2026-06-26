import { createHash, randomUUID } from "node:crypto";
import { PermissionSet, WorkflowNodeConfig } from "../config/schema.js";
import { ModelMessage, ModelProvider, ModelToolCall } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { Tool, ToolResult } from "../tools/types.js";
import { RunStore } from "../storage/runStore.js";
import { buildNodeMessages } from "./context.js";
import { decidePermission } from "./permissions.js";
import { NodeResult, nodeResultJsonSchema, nodeResultSchema, parseNodeResult, visibleAssistantTextBeforeNodeResult } from "../team/nodeResult.js";
import { PermissionDecision, PermissionRequest } from "./permissionController.js";
import { HarnessEvent, StoredEvent } from "./events.js";
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
  dialogueMessages?: ModelMessage[];
  onDialogueMessages?: (messages: ModelMessage[]) => Promise<void> | void;
  interaction?: RuntimeInteraction;
  eventSink?: (event: StoredEvent) => void;
};
export async function runNode(options: NodeRuntimeOptions): Promise<NodeResult> {
  const baseMessages = await buildNodeMessages(options.node, options.systemPrompt, options.handoff);
  const messages: ModelMessage[] = [...baseMessages, ...(options.dialogueMessages ?? [])];
  const baseMessageCount = baseMessages.length;
  const attempt = options.attempt ?? 1;
  const artifactDeliverables: NodeResult["deliverables"] = [];
  const requestTools = [...options.tools.list(), submitNodeResultTool];
  let resultRepairAttempts = 0;
  let toolPreambleRepairAttempts = 0;
  const persistDialogueMessages = async () => {
    await options.onDialogueMessages?.(messages.slice(baseMessageCount));
  };
  const appendDialogueMessage = async (message: ModelMessage) => {
    messages.push(message);
    await persistDialogueMessages();
  };
  for (;;) {
    const request = {
      model: options.model,
      messages,
      tools: requestTools,
      response_schema: requestTools.length ? undefined : nodeResultJsonSchema,
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
    const streamed = Boolean(options.provider.stream);
    const response = options.provider.stream
      ? await options.provider.stream(request, (event) => {
        streamEventWrites = streamEventWrites.then(() => appendRuntimeEvent(options, {
          type: event.type === "thinking_delta" ? "model_thinking_delta" : "model_stream_delta",
          node_id: options.node.id,
          attempt,
          text: event.text
        }));
      })
      : await options.provider.generate(request);
    await streamEventWrites;
    if (!streamed) await appendNonStreamingResponseEvents(options, attempt, response);
    if (response.tool_calls?.length) {
      const submittedResult = response.tool_calls.find((call) => call.name === submitNodeResultTool.name);
      if (submittedResult) {
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
        const specifier = toolSpecifier(call.name, call.input);
        const permission = decidePermission(call.name, specifier, options.permissions);
        if (permission.decision === "deny") {
          const error = `Permission denied for ${call.name}: ${permission.rule ?? "no rule"}`;
          await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
          throw new Error(error);
        }
        if (permission.decision === "ask") {
          if (!options.interaction?.requestPermission) {
            const error = `Permission ask is not interactive in this MVP for ${call.name}`;
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
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
          if (decision === "deny_once") {
            const error = `Permission denied by user for ${call.name}`;
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error });
            await appendDialogueMessage({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error }) });
            continue;
          }
        }
        await appendRuntimeEvent(options, { type: "tool_invoked", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, input: call.input });
        try {
          const tool = options.tools.get(call.name);
          const result = await tool.execute(call.input, { cwd: options.cwd, runDir: options.store.runDir(options.runId), nodeId: options.node.id, attempt });
          await appendRuntimeEvent(options, { type: "tool_completed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, result });
          const artifact = artifactFromToolResult(result);
          if (artifact) {
            await appendRuntimeEvent(options, { type: "artifact_created", node_id: options.node.id, artifact_id: artifact.artifact_id, path: artifact.path });
            if (!artifactDeliverables.some((item) => item.artifact_id === artifact.artifact_id)) {
              artifactDeliverables.push({ artifact_id: artifact.artifact_id, description: artifact.description });
            }
          }
          await appendDialogueMessage({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, tool_call_id: call.id, tool: call.name, error: message });
          await appendDialogueMessage({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) });
        }
      }
      continue;
    }
    if (!response.content) throw new Error(`Node ${options.node.id} returned no content and no tool calls`);
    try {
      const result = mergeArtifactDeliverables(parseNodeResult(response.content), artifactDeliverables);
      if (result.status !== "success") await appendDialogueMessage({ role: "assistant", content: response.content });
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
  description: "Submit the final NodeResult object for this workflow node. Use this only when the node is complete or needs user input.",
  input_schema: nodeResultJsonSchema as unknown as Record<string, unknown>,
  async execute() {
    return { error: "SubmitNodeResult is handled by the runtime", exit_code: 1 };
  }
};
function artifactFromToolResult(result: ToolResult): { artifact_id: string; path: string; description: string } | undefined {
  if (!result.artifact_id || !result.path) return undefined;
  return { artifact_id: result.artifact_id, path: result.path, description: result.description ?? "" };
}
function nodeResultRepairPrompt(error: unknown): string {
  return [
    "The previous response was not a valid final NodeResult.",
    `Validation error: ${errorMessage(error)}`,
    "Return exactly one valid NodeResult JSON object and nothing else.",
    "Do not include multiple JSON objects, Markdown fences, explanations, or revisions.",
    "Use needs_user_input only when user input is required, and include at least one concrete question in questions."
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
